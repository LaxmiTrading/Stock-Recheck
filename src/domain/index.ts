/**
 * Shared domain layer.
 *
 * Everything in `src/domain` is PURE: no React, no DOM, no database, no fetch.
 * It is imported by the React app AND by the Netlify functions so that the
 * business rules in the specification exist exactly once (section 44).
 */

export * from './sku';
export * from './quantity';
export * from './status';
export * from './permissions';
export * from './failureCodes';
export * from './exportContract';
export * from './recheckNumber';
export * from './claims';
export * from './stockBasis';
export * from './settings';
export * from './scanning';
export * from './audit';
