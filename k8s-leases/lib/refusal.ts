// An expected refusal: a stable code the guard can branch on, a sentence
// for the agent, and any extra fields the JSON should carry.
export class Refusal extends Error {
  readonly code: string;
  readonly extra: Record<string, string | number | boolean>;
  constructor(code: string, message: string, extra: Record<string, string | number | boolean> = {}) {
    super(message);
    this.code = code;
    this.extra = extra;
    this.name = "Refusal";
  }

  toJSON(): Record<string, string | number | boolean> {
    return { error: this.message, code: this.code, ...this.extra };
  }
}
