#!/usr/bin/env node
// Generates CycloneDX and SPDX SBOMs into the sbom/ folder using npm's built-in generator.
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'sbom');
const name = 'NodeLicenseDashboard';

const formats = [
  { format: 'cyclonedx', file: `${name}.cyclonedx.json` },
  { format: 'spdx', file: `${name}.spdx.json` },
];

mkdirSync(outDir, { recursive: true });

for (const { format, file } of formats) {
  const json = execSync(
    `npm sbom --sbom-format ${format} --sbom-type application`,
    { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  writeFileSync(join(outDir, file), json);
  console.log(`SBOM written: sbom/${file}`);
}
