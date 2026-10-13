import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Mark route as public - no JWT required.
 * `@Public(false)` on a method re-requires a JWT inside a `@Public()` class
 * (method metadata wins over class metadata).
 */
export const Public = (isPublic = true) => SetMetadata(IS_PUBLIC_KEY, isPublic);
