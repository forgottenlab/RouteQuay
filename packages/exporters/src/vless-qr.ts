import qrcodeFactory from "qrcode-generator";
import { PNG } from "pngjs";

import { renderVlessRealityUri, type ClientConnectionSpec } from "./client-connection.ts";

const QR_SCALE = 8;
const QR_MARGIN_MODULES = 2;

/**
 * Offline PNG QR for the same VLESS REALITY URI as v2rayn export. No network APIs.
 */
const qrcode = qrcodeFactory as (typeNumber: 0, errorCorrectionLevel: "M") => {
  addData(data: string): void;
  make(): void;
  getModuleCount(): number;
  isDark(row: number, col: number): boolean;
};

export function renderVlessQrPng(spec: ClientConnectionSpec): Buffer {
  const uri = renderVlessRealityUri(spec).replace(/\n$/, "");
  const qr = qrcode(0, "M");
  qr.addData(uri);
  qr.make();
  const modules = qr.getModuleCount();
  const dimension = (modules + QR_MARGIN_MODULES * 2) * QR_SCALE;
  const png = new PNG({ width: dimension, height: dimension, colorType: 6, inputColorType: 6, inputHasAlpha: true });
  png.data.fill(255);
  for (let y = 0; y < dimension; y++) {
    for (let x = 0; x < dimension; x++) {
      const moduleX = Math.floor(x / QR_SCALE) - QR_MARGIN_MODULES;
      const moduleY = Math.floor(y / QR_SCALE) - QR_MARGIN_MODULES;
      const dark = moduleX >= 0 && moduleX < modules && moduleY >= 0 && moduleY < modules
        && qr.isDark(moduleY, moduleX);
      if (!dark) continue;
      const offset = (dimension * y + x) << 2;
      png.data[offset] = 0;
      png.data[offset + 1] = 0;
      png.data[offset + 2] = 0;
      png.data[offset + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}