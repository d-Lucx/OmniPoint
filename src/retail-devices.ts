export type DeviceKind = 'PRINTER' | 'DRAWER';
export type DeviceMode = 'OK' | 'DISCONNECTED' | 'PAPER_OUT' | 'DELAYED';
export interface DeviceCommand { id: string; kind: DeviceKind; payload: string | null }
export interface DeviceAdapter { dispatch(command: DeviceCommand): Promise<'OK' | 'DISCONNECTED' | 'PAPER_OUT'> }

export class SimulatedDevices implements DeviceAdapter {
  readonly calls: DeviceCommand[] = [];
  readonly modes = new Map<DeviceKind, DeviceMode>();
  private readonly delayed = new Map<string, (result: 'OK') => void>();

  async dispatch(command: DeviceCommand): Promise<'OK' | 'DISCONNECTED' | 'PAPER_OUT'> {
    this.calls.push(command);
    const mode = this.modes.get(command.kind) ?? 'OK';
    if (mode === 'DELAYED') return new Promise(resolve => { this.delayed.set(command.id, resolve); });
    return mode;
  }

  finishDelayed(commandId: string): boolean {
    const finish = this.delayed.get(commandId);
    if (!finish) return false;
    this.delayed.delete(commandId);
    finish('OK');
    return true;
  }
}

export async function observeDevice(adapter: DeviceAdapter, command: DeviceCommand, timeout: number) {
  let timer: NodeJS.Timeout | undefined;
  try {
    const outcome = await Promise.race([
      adapter.dispatch(command),
      new Promise<'TIMEOUT'>(resolve => { timer = setTimeout(() => resolve('TIMEOUT'), timeout); }),
    ]);
    if (outcome === 'OK') return { state: 'SUCCEEDED', detail: outcome };
    return { state: outcome === 'TIMEOUT' ? 'UNCERTAIN' : 'FAILED', detail: outcome };
  } catch {
    return { state: 'UNCERTAIN', detail: 'ADAPTER_ERROR' };
  } finally {
    clearTimeout(timer);
  }
}
