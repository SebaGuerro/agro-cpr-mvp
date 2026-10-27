// Problem codes shared with the OpenAPI spec (components.schemas.Problem.code).
const STATUS = {
  UNAUTHENTICATED: 401,
  FORBIDDEN_ROLE: 403,
  FORBIDDEN_ORG: 403,
  VALIDATION_FAILED: 422,
  NOT_FOUND: 404,
  INVALID_TRANSITION: 422,
  CPR_ALREADY_EXISTS: 409,
  ISSUED_ABOVE_ELIGIBLE: 422,
  WRONG_WAREHOUSE: 422,
  DELIVERY_NOT_FOUND: 422,
  QUANTITY_EXCEEDS_AVAILABLE: 422,
  EVIDENCE_REQUIRED: 422,
  EVENT_ID_CONFLICT: 409,
  CORRECTION_BREAKS_STREAM: 422,
  BATCH_ALREADY_ANCHORED: 409,
  LAND_ALREADY_REGISTERED: 409,
  CYCLE_ALREADY_EXISTS: 409,
} as const;

export type ProblemCode = keyof typeof STATUS;

export interface FieldError {
  path: string;
  message: string;
}

export class ApiError extends Error {
  constructor(
    readonly code: ProblemCode,
    message: string,
    readonly errors?: FieldError[],
  ) {
    super(message);
  }

  get status(): number {
    return STATUS[this.code];
  }
}

export function fail(code: ProblemCode, message: string): never {
  throw new ApiError(code, message);
}
