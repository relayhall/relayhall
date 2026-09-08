/**
 * Typed request-fault errors (review 3db17273 B4, extending the review
 * 14c7f96d B1 precedent that routes classify by CLASS, never by message
 * substring): a service throws one of these to NAME a caller-visible
 * outcome, and routes translate ONLY these classes into non-500 envelopes.
 * Every other caught value takes the fixed unknown-500 envelope, so a
 * foreign error whose message happens to contain a dispatch phrase can
 * never be relayed to a caller. Message text on these classes is
 * developer-authored by construction.
 */
export class RequestFaultError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class NotFoundFault extends RequestFaultError {
  constructor(message: string, code = 'NOT_FOUND') { super(404, code, message); }
}

export class ForbiddenFault extends RequestFaultError {
  constructor(message: string, code = 'FORBIDDEN') { super(403, code, message); }
}

export class ConflictFault extends RequestFaultError {
  constructor(message: string, code = 'CONFLICT') { super(409, code, message); }
}

export class InvalidRequestFault extends RequestFaultError {
  constructor(message: string, code = 'INVALID_REQUEST') { super(400, code, message); }
}

/**
 * The TARGET Project of a Task write is not one this caller may reach - or
 * does not exist (card `9c177e6a`).
 *
 * ONE class for both, carrying ONE message, because the answer has to be one
 * answer: AUTHZ `4d961e37` par.9.6 (the 44d1bf89 rule) says an object the
 * caller may not read is reported exactly as an absent one, and a second class
 * for the authorization half would be a second answer waiting for a route to
 * spell it differently. It takes no constructor arguments for the same reason
 * - there is nothing about the target for a caller to learn here.
 */
export class ProjectTargetNotFoundFault extends NotFoundFault {
  constructor() { super('Project not found', 'PROJECT_NOT_FOUND'); }
}
