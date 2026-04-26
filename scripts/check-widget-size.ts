#!/usr/bin/env bun
import { statSync } from 'node:fs';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const BUDGET_BYTES = 40 * 1024;
const WIDGET_IIFE = join(import.meta.dir, '..', 'packages', 'widget', 'dist', 'widget.iife.js');

if (!existsSync(WIDGET_IIFE)) {
  console.error(`widget bundle not found at ${WIDGET_IIFE}. run bun run build:widget first.`);
  process.exit(2);
}

const raw = readFileSync(WIDGET_IIFE);
const gz = gzipSync(raw, { level: 9 });
const rawKb = (raw.length / 1024).toFixed(1);
const gzKb = (gz.length / 1024).toFixed(1);

console.log(
  `widget.iife.js: ${rawKb} KB raw, ${gzKb} KB gzipped (budget: ${BUDGET_BYTES / 1024} KB gz)`,
);

if (gz.length > BUDGET_BYTES) {
  console.error(`❌ OVER BUDGET by ${((gz.length - BUDGET_BYTES) / 1024).toFixed(1)} KB gzipped`);
  process.exit(1);
}

console.log('✅ within budget');

// side-effect: touch stat so any tooling picks up the build time
statSync(WIDGET_IIFE);
