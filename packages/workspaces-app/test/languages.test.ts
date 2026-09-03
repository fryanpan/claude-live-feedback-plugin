import { describe, expect, it } from 'vitest';
import { languageExtensionFor } from '../src/code/languages.ts';

/**
 * The File view promises syntax highlighting for file types typical of
 * Android, iOS, and web frontend/backend projects. Each case here is a real
 * file name from one of those stacks — a null means that file renders as
 * unhighlighted plain text.
 */
describe('languageExtensionFor', () => {
  const covered: string[] = [
    // Android
    'app/src/main/java/com/x/Main.java',
    'app/src/main/kotlin/com/x/Main.kt',
    'settings.gradle.kts',
    'app/src/main/AndroidManifest.xml',
    'res/layout/activity_main.xml',
    'build.gradle',
    'gradle.properties',
    'proguard-rules.pro',
    // iOS
    'Sources/App/AppDelegate.swift',
    'Classes/Legacy.m',
    'Classes/Legacy.h',
    'Podfile',
    'Info.plist',
    // web frontend
    'src/index.html',
    'src/styles.css',
    'src/styles.scss',
    'src/app.tsx',
    'src/util.js',
    'src/data.json',
    // backend / config
    'server/main.py',
    'db/schema.sql',
    'config/app.yaml',
    'config/app.yml',
    'Gemfile',
    'scripts/deploy.sh',
    'Cargo.toml',
    'README.md',
  ];

  for (const path of covered) {
    it(`highlights ${path}`, () => {
      expect(languageExtensionFor(path)).not.toBeNull();
    });
  }

  it('returns null for unknown types (plain-text degraded behavior)', () => {
    expect(languageExtensionFor('binary.blob')).toBeNull();
    expect(languageExtensionFor('noext')).toBeNull();
  });
});
