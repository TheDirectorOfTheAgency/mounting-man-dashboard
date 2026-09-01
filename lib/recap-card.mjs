// 4:5 recap card for X (1080x1350). Frozen tux/TV plate + stamped totals.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

export const RECAP_CARD_WIDTH = 1080;
export const RECAP_CARD_HEIGHT = 1350;

const GOLD = [234, 160, 51];
const GOLD_DIM = [140, 112, 28];
const CREAM = [236, 214, 150];
const MUTED = [220, 170, 70];
const PLATE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'assets', 'recap-plate.png');
const BG = [18, 16, 14];
const SLAT = [28, 24, 20];
const SLAT_EDGE = [42, 36, 30];
