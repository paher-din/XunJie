export class RunnerError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'RunnerError';
    this.code = code;
  }
}

