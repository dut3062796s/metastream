import { hostname } from 'os';
import { ipcRenderer, remote } from 'electron';

import { Platform, ILobbyOptions, ILobbySession, ILobbyData } from 'renderer/platform/types';
import { Deferred } from 'utils/async';
import { ElectronRTCPeerCoordinator } from 'renderer/platform/electron/peer-coordinator';
import { ElectronLobby } from 'renderer/platform/electron/lobby';
import { NetUniqueId } from 'renderer/network';
import { IRTCPeerCoordinator } from 'renderer/network/rtc';

export class ElectronPlatform extends Platform {
  private id: NetUniqueId<number>;
  private currentSession: ElectronLobby | null;

  async createLobby(opts: ILobbyOptions): Promise<boolean> {
    const lobby = await ElectronLobby.createLobby();
    this.currentSession = lobby;
    return !!lobby;
  }

  async joinLobby(id: string): Promise<boolean> {
    const lobby = await ElectronLobby.joinLobby(id);
    this.currentSession = lobby;
    return !!lobby;
  }

  leaveLobby(id: string): boolean {
    if (this.currentSession) {
      this.currentSession.close();
      this.currentSession = null;
    }
    return true;
  }

  async findLobbies(): Promise<ILobbySession[]> {
    const deferred = new Deferred<ILobbySession[]>();

    ipcRenderer.once('platform-query-result', (event: any, results: any) => {
      deferred.resolve(results);
    });

    ipcRenderer.send('platform-query', {});

    return await deferred.promise;
  }

  getLobbyData(): ILobbyData | null {
    // TODO
    return null;
  }

  createPeerCoordinator(): IRTCPeerCoordinator {
    if (!this.currentSession) {
      throw new Error('[Electron Platform] createPeerCoordinator: No active session.');
    }

    return new ElectronRTCPeerCoordinator(this.currentSession);
  }

  getUserName(userId: NetUniqueId): string {
    return `${hostname()}-${userId.toString()}`;
  }

  getLocalId(): NetUniqueId {
    if (!this.id) {
      const win = remote.getCurrentWindow();
      const id = win.id;
      this.id = new NetUniqueId(id);
    }
    return this.id;
  }

  async requestUserInfo(id: NetUniqueId | string): Promise<any> {}
  async requestAvatarUrl(id: NetUniqueId | string): Promise<string | void> {}
}
