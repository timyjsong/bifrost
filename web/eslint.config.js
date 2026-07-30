import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
    },
    rules: {
      // Hooks-plugin v6 compiler-era rules postdate this codebase's
      // optimistic-state idioms — kept visible as warnings, not gate-breakers.
      //
      // Reviewed in full (2026-07-30), 20 warnings down to 15. What was real got
      // fixed: three renders called Date.now() instead of taking the app's 1s
      // clock as a prop, one component reset state from a prop in an effect
      // (which paints a stale frame first, so the control visibly flickers back),
      // and DriveView hand-cleared state on session change that its own
      // `key={sessionId}` remount already discards.
      //
      // The rest are deliberate. They are subscribe-and-reset effects (the
      // session stream and pane poll clearing stale data before re-subscribing),
      // one-time mount effects reading window.location, and render-time ref
      // latches in the drive-target resolution. Each is the shape the rule warns
      // about and the correct thing to write here; rewriting them would trade
      // working code for a quieter lint run. There are no component tests, so
      // that trade has no safety net — leave them, or add the tests first.
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/refs': 'warn',
      'react-hooks/purity': 'warn',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
])
