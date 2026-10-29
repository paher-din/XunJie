import type { BoardProfile } from '../../contracts/runner/hdl.ts';

export const board: BoardProfile = {
  boardProfileVersion: 'nexys4-ddr-rev-c-v1', mappingVersion: 'synthetic-mapping-v1', topModule: 'top', bindings: [
    { signal: 'clock', offset: 0, port: 'clk', portOffset: 0, width: 1 }, { signal: 'switches', offset: 0, port: 'sw', portOffset: 0, width: 16 },
    { signal: 'buttons', offset: 0, port: 'btn', portOffset: 0, width: 5 }, { signal: 'leds', offset: 0, port: 'led', portOffset: 0, width: 16 },
    { signal: 'anodes', offset: 0, port: 'an', portOffset: 0, width: 8 }, { signal: 'segments', offset: 0, port: 'seg', portOffset: 0, width: 7 },
    { signal: 'dp', offset: 0, port: 'dp', portOffset: 0, width: 1 }]
};
