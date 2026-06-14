import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { buildObfuscatedEngagementScript } from '../src/modules/engagement/engagement-script.cache';

const outputDir = join(__dirname, '../dist/engagement');
const outputPath = join(outputDir, 'pl.obfuscated.js');

mkdirSync(outputDir, { recursive: true });
writeFileSync(outputPath, buildObfuscatedEngagementScript(), 'utf8');

console.log(`Engagement script prebuilt at ${outputPath}`);
