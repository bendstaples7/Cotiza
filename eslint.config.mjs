import tseslint from 'typescript-eslint';

/**
 * Surgical regression-guard lint config.
 *
 * It intentionally does NOT extend any recommended rule set (that would flag
 * thousands of pre-existing issues and add noise). It adds only two guards on
 * top of the TypeScript parser, each targeting a failure class that previously
 * broke production:
 *
 *  1. Hardcoded GitHub owner/repo slug — once dispatched the cookie-refresh
 *     workflow to the wrong repository. The slug must live ONLY in src/config.ts.
 *  2. Raw `throw new Error()` in user-facing surfaces (routes + queue consumer)
 *     — surfaces as an opaque HTTP 500. Require a classified PlatformError.
 *  3. `undefined as any` — the exact cast that let an undefined value reach a
 *     D1 bind and crash the Quick Post flow with a raw D1_TYPE_ERROR.
 *  4. Hardcoded `/media/thumbnail/` paths — must use buildMediaThumbnailPath()
 *     from shared so stored URLs match the public serve route + client proxy.
 */

const mediaThumbnailLiteralRule = {
  selector: 'Literal[value="/media/thumbnail/"]',
  message:
    'Do not hardcode /media/thumbnail/ paths. Use buildMediaThumbnailPath()/MEDIA_THUMBNAIL_PREFIX from shared/src/media-urls.ts.',
};

const slugRules = [
  {
    selector: 'Literal[value=/bendstaples7\\//]',
    message:
      'Do not hardcode the GitHub owner/repo slug. Use getGithubRepo()/EXTERNAL from src/config.ts.',
  },
  {
    selector: 'Literal[value=/api\\.github\\.com\\/repos/]',
    message:
      'Do not hardcode GitHub repo API URLs. Use getCookieRefreshDispatchUrl()/EXTERNAL from src/config.ts.',
  },
];

const rawErrorRule = {
  selector: "ThrowStatement > NewExpression[callee.name='Error']",
  message:
    'Throw a PlatformError (not a raw Error) so failures are classified and return a clear status instead of a 500.',
};

const undefinedAsAnyRule = {
  selector: 'TSAsExpression[typeAnnotation.type="TSAnyKeyword"] > Identifier[name="undefined"]',
  message:
    'Do not cast `undefined as any` into a value. Normalize optional fields to null (e.g. emptyToNull) so undefined never reaches a D1 bind.',
};

export default [
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/*.d.ts', 'worker/src/migrations/**'],
  },
  {
    files: ['worker/src/**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
    },
    rules: {
      'no-restricted-syntax': ['error', ...slugRules, undefinedAsAnyRule, mediaThumbnailLiteralRule],
    },
  },
  {
    // Routes + queue consumer are the user-facing surfaces. Selectors are
    // repeated because `no-restricted-syntax` config replaces (not merges).
    files: ['worker/src/routes/**/*.ts', 'worker/src/queue/**/*.ts'],
    rules: {
      'no-restricted-syntax': ['error', ...slugRules, undefinedAsAnyRule, mediaThumbnailLiteralRule, rawErrorRule],
    },
  },
  {
    // config.ts is the single allowed home for external identifiers.
    files: ['worker/src/config.ts'],
    rules: {
      'no-restricted-syntax': 'off',
    },
  },
  {
    files: ['shared/src/media-urls.ts'],
    rules: {
      'no-restricted-syntax': 'off',
    },
  },
];
