// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
'use strict';
import '../../../common/extensions';

import * as os from 'os';
import * as vscode from 'vscode';
import { CancellationToken } from 'vscode-jsonrpc';
import * as vsls from 'vsls/vscode';

import { ILiveShareApi } from '../../../common/application/types';
import { traceInfo } from '../../../common/logger';
import { IAsyncDisposableRegistry, IConfigurationService, IDisposableRegistry } from '../../../common/types';
import * as localize from '../../../common/utils/localize';
import { StopWatch } from '../../../common/utils/stopWatch';
import { sendTelemetryEvent } from '../../../telemetry';
import { Identifiers, LiveShare, LiveShareCommands, RegExpValues, Telemetry } from '../../constants';
import {
    IDataScience,
    IJupyterSession,
    IJupyterSessionManager,
    IJupyterSessionManagerFactory,
    INotebook,
    INotebookExecutionLogger,
    INotebookServer,
    INotebookServerLaunchInfo
} from '../../types';
import { JupyterServerBase } from '../jupyterServer';
import { HostJupyterNotebook } from './hostJupyterNotebook';
import { LiveShareParticipantHost } from './liveShareParticipantMixin';
import { IRoleBasedObject } from './roleBasedFactory';

// tslint:disable-next-line: no-require-imports
// tslint:disable:no-any

export class HostJupyterServer
    extends LiveShareParticipantHost(JupyterServerBase, LiveShare.JupyterServerSharedService)
    implements IRoleBasedObject, INotebookServer {
    private disposed = false;
    private portToForward = 0;
    private sharedPort: vscode.Disposable | undefined;
    constructor(
        private liveShare: ILiveShareApi,
        _dataScience: IDataScience,
        asyncRegistry: IAsyncDisposableRegistry,
        disposableRegistry: IDisposableRegistry,
        configService: IConfigurationService,
        sessionManager: IJupyterSessionManagerFactory,
        loggers: INotebookExecutionLogger[]) {
        super(liveShare, asyncRegistry, disposableRegistry, configService, sessionManager, loggers);
    }

    public async dispose(): Promise<void> {
        if (!this.disposed) {
            this.disposed = true;
            await super.dispose();
            const api = await this.api;
            return this.onDetach(api);
        }
    }

    public async connect(launchInfo: INotebookServerLaunchInfo, cancelToken?: CancellationToken): Promise<void> {
        if (launchInfo.connectionInfo && launchInfo.connectionInfo.localLaunch) {
            const portMatch = RegExpValues.ExtractPortRegex.exec(launchInfo.connectionInfo.baseUrl);
            if (portMatch && portMatch.length > 1) {
                const port = parseInt(portMatch[1], 10);
                await this.attemptToForwardPort(this.finishedApi, port);
            }
        }
        return super.connect(launchInfo, cancelToken);
    }

    public async onAttach(api: vsls.LiveShare | null): Promise<void> {
        await super.onAttach(api);

        if (api && !this.disposed) {
            const service = await this.waitForService();

            // Attach event handlers to different requests
            if (service) {
                // Requests return arrays
                service.onRequest(LiveShareCommands.syncRequest, (_args: any[], _cancellation: CancellationToken) => this.onSync());
                service.onRequest(LiveShareCommands.disposeServer, (_args: any[], _cancellation: CancellationToken) => this.dispose());
                service.onRequest(LiveShareCommands.createNotebook, async (args: any[], cancellation: CancellationToken) => {
                    // Translate the uri into local if possible
                    const uri = args[0] as vscode.Uri;
                    const resource = (uri.scheme && uri.scheme !== Identifiers.InteractiveWindowIdentityScheme) ? this.finishedApi!.convertSharedUriToLocal(args[0]) : uri;
                    // Don't return the notebook. We don't want it to be serialized. We just want its live share server to be started.
                    const notebook = await this.createNotebook(resource, cancellation) as HostJupyterNotebook;
                    await notebook.onAttach(api);
                });

                // See if we need to forward the port
                await this.attemptToForwardPort(api, this.portToForward);
            }
        }
    }

    public async onDetach(api: vsls.LiveShare | null): Promise<void> {
        await super.onDetach(api);

        // Make sure to unshare our port
        if (api && this.sharedPort) {
            this.sharedPort.dispose();
            this.sharedPort = undefined;
        }
    }

    public async waitForServiceName(): Promise<string> {
        // First wait for connect to occur
        const launchInfo = await this.waitForConnect();

        // Use our base name plus our purpose. This means one unique server per purpose
        if (!launchInfo) {
            return LiveShare.JupyterServerSharedService;
        }
        // tslint:disable-next-line:no-suspicious-comment
        // TODO: Should there be some separator in the name?
        return `${LiveShare.JupyterServerSharedService}${launchInfo.purpose}`;
    }

    protected async createNotebookInstance(
        resource: vscode.Uri,
        sessionManager: IJupyterSessionManager,
        possibleSession: IJupyterSession | undefined,
        disposableRegistry: IDisposableRegistry,
        configService: IConfigurationService,
        loggers: INotebookExecutionLogger[],
        cancelToken?: CancellationToken): Promise<INotebook> {

        // See if already exists.
        const existing = await this.getNotebook(resource);
        if (existing) {
            // Dispose the possible session as we don't need it
            if (possibleSession) {
                await possibleSession.dispose();
            }

            // Then we can return the existing notebook.
            return existing;
        }

        // Otherwise create a new notebook.

        // First we need our launch information so we can start a new session (that's what our notebook is really)
        const launchInfo = await this.waitForConnect();
        if (!launchInfo) {
            throw this.getDisposedError();
        }

        // Start a session (or use the existing one)
        const session = possibleSession || await sessionManager.startNew(launchInfo.kernelSpec, cancelToken);
        traceInfo(`Started session ${this.id}`);

        if (session) {
            // Create our notebook
            const notebook = new HostJupyterNotebook(
                this.liveShare,
                session,
                configService,
                disposableRegistry,
                this,
                launchInfo,
                loggers,
                resource,
                this.getDisposedError.bind(this));

            // Wait for it to be ready
            traceInfo(`Waiting for idle ${this.id}`);
            const stopWatch = new StopWatch();
            const idleTimeout = configService.getSettings().datascience.jupyterLaunchTimeout;
            await notebook.waitForIdle(idleTimeout);
            sendTelemetryEvent(Telemetry.WaitForIdleJupyter, stopWatch.elapsedTime);

            // Run initial setup
            await notebook.initialize(cancelToken);

            traceInfo(`Finished connecting ${this.id}`);

            // Save the notebook
            this.setNotebook(resource, notebook);

            // Return the result.
            return notebook;
        }

        throw this.getDisposedError();
    }

    private async attemptToForwardPort(api: vsls.LiveShare | null | undefined, port: number): Promise<void> {
        if (port !== 0 && api && api.session && api.session.role === vsls.Role.Host) {
            this.portToForward = 0;
            this.sharedPort = await api.shareServer({ port, displayName: localize.DataScience.liveShareHostFormat().format(os.hostname()) });
        } else {
            this.portToForward = port;
        }
    }

    private onSync(): Promise<any> {
        return Promise.resolve(true);
    }

}
