import type { HdlBoardProfile } from './hdlContracts'

/** Pure browser wire types also consumed by tools; no browser runtime imports. */
export interface HdlActivityExecution {
  kind: 'hdl_board'
  runtimeProfileVersion: string
  contentHash: string
  configuration: {
    versionId: string
    board: HdlBoardProfile
    runtime: { runtimeProfileVersion: string; engineVersion: string; buildImage: string; runtimeImage: string; sourceHash: string }
    signals: { bitOrder: 'msb_first'; clockHz: 100000000; initialClock: '0'; initialSwitches: '0000000000000000'
      initialButtons: '00000'; initialResetN: '1'; stableSampling: 'low_phase'; anodesActive: 'low'; segmentsActive: 'low'; dpActive: 'low' }
    alu: unknown
    structuralCoverage: 'board_bindings_and_defined_alu_domain'
  }
}
