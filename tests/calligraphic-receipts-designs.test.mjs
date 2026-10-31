import test from 'node:test';
import {existsSync} from 'node:fs';

// Parity checks between the calligraphic-receipts engine port and its V4 pilot design in docs/superpowers/, the maker's private
// planning folder that is not published with the studio. Where it is absent, the check is reported as skipped.
const pilot = new URL('../docs/superpowers/specs/assets/v4-pilots/calligraphic-receipts/design.tsx', import.meta.url);
if (existsSync(pilot)) await import('./calligraphic-receipts-designs.pilot.mjs');
else test('calligraphic-receipts port matches its V4 pilot design', {skip: 'private pilot design (docs/superpowers) is not in this checkout'}, () => {});
