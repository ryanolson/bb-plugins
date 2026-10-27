// A refusal the page and the CLI both show: the request was not carried out,
// and nothing was written.

export type RefusalCode = "conflict" | "invalid" | "not_found";

/** A refusal shared by the page and the CLI: nothing was posted. */
export class Refusal extends Error {
  readonly code: RefusalCode;
  constructor(code: RefusalCode, message: string) {
    super(message);
    this.code = code;
  }
}
