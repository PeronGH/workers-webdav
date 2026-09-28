import js from '@eslint/js';
import prettier from 'eslint-config-prettier/flat';
import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig(
	globalIgnores(['worker-configuration.d.ts']),
	{
		files: ['**/*.{js,mjs,ts,mts}'],
		extends: [js.configs.recommended, tseslint.configs.strictTypeChecked, tseslint.configs.stylisticTypeChecked],
		languageOptions: {
			parserOptions: {
				projectService: {
					allowDefaultProject: ['*.config.ts', '*.config.mts'],
				},
			},
		},
	},
	prettier,
);
