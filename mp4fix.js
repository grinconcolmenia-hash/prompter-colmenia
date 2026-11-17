// Repara tomas MP4 fragmentadas del iPhone. Cuando a la grabación dejan de llegarle cuadros por un
// momento, Safari escribe esa muestra con duración 0xFFFFFFFF: la toma dice durar 83 días y la imagen
// se congela. Aquí se busca esa muestra y se le pone la duración que cuadra con el audio.
// Solo se reescriben las cajas moof (pequeñas); el video y el audio se copian tal cual.
(function () {
  const BAD = 0x7fffffff;

  async function bytes(blob, pos, n) {
    return new DataView(await blob.slice(pos, pos + n).arrayBuffer());
  }

  // Lista las cajas hijas de [start, end) dentro de un DataView.
  function children(dv, start, end) {
    const out = [];
    for (let p = start; p + 8 <= end;) {
      let len = dv.getUint32(p), hdr = 8;
      const type = String.fromCharCode(dv.getUint8(p + 4), dv.getUint8(p + 5), dv.getUint8(p + 6), dv.getUint8(p + 7));
      if (len === 1) { len = Number(dv.getBigUint64(p + 8)); hdr = 16; }
      if (len === 0) len = end - p;
      if (len < 8) break;
      out.push({ type, start: p, body: p + hdr, end: p + len });
      p += len;
    }
    return out;
  }
  const find = (dv, box, type) => children(dv, box.body, box.end).filter((b) => b.type === type);

  async function fixMp4Durations(blob) {
    // Cajas de primer nivel, leyendo solo sus encabezados.
    const top = [];
    for (let p = 0; p + 8 <= blob.size;) {
      const h = await bytes(blob, p, 16);
      let len = h.getUint32(0);
      const type = String.fromCharCode(h.getUint8(4), h.getUint8(5), h.getUint8(6), h.getUint8(7));
      if (len === 1) len = Number(h.getBigUint64(8));
      if (len === 0) len = blob.size - p;
      if (len < 8) return blob;
      top.push({ type, start: p, len });
      p += len;
    }
    const moovBox = top.find((b) => b.type === "moov");
    const moofs = top.filter((b) => b.type === "moof");
    if (!moovBox || !moofs.length) return blob;

    // Pistas: id, escala de tiempo, si es video o audio, y la duración por defecto de trex.
    const moov = await bytes(blob, moovBox.start, moovBox.len);
    const root = { body: 8, end: moovBox.len };
    const tracks = {};
    for (const trak of find(moov, root, "trak")) {
      const tkhd = find(moov, trak, "tkhd")[0], mdia = find(moov, trak, "mdia")[0];
      if (!tkhd || !mdia) continue;
      const id = moov.getUint32(tkhd.body + (moov.getUint8(tkhd.body) === 1 ? 20 : 12));
      const mdhd = find(moov, mdia, "mdhd")[0], hdlr = find(moov, mdia, "hdlr")[0];
      const scale = moov.getUint32(mdhd.body + (moov.getUint8(mdhd.body) === 1 ? 20 : 12));
      const kind = String.fromCharCode(...[0, 1, 2, 3].map((i) => moov.getUint8(hdlr.body + 8 + i)));
      tracks[id] = { scale, kind, def: 0, total: 0, bad: [], durs: [] };
    }
    for (const mvex of find(moov, root, "mvex")) {
      for (const trex of find(moov, mvex, "trex")) {
        const t = tracks[moov.getUint32(trex.body + 4)];
        if (t) t.def = moov.getUint32(trex.body + 12);
      }
    }

    // Recorre cada moof y anota dónde está la duración de cada muestra.
    const bufs = [];
    for (const m of moofs) {
      const dv = await bytes(blob, m.start, m.len);
      bufs.push(dv);
      for (const traf of find(dv, { body: 8, end: m.len }, "traf")) {
        const tfhd = find(dv, traf, "tfhd")[0];
        if (!tfhd) continue;
        const tf = dv.getUint32(tfhd.body) & 0xffffff, t = tracks[dv.getUint32(tfhd.body + 4)];
        if (!t) continue;
        let o = tfhd.body + 8;
        if (tf & 1) o += 8;
        if (tf & 2) o += 4;
        const defAt = tf & 8 ? o : -1;
        const def = defAt >= 0 ? dv.getUint32(defAt) : t.def;
        for (const trun of find(dv, traf, "trun")) {
          const rf = dv.getUint32(trun.body) & 0xffffff, n = dv.getUint32(trun.body + 4);
          let p = trun.body + 8;
          if (rf & 1) p += 4;
          if (rf & 4) p += 4;
          const per = [0x100, 0x200, 0x400, 0x800].filter((f) => rf & f).length * 4;
          for (let i = 0; i < n; i++) {
            const at = rf & 0x100 ? p + i * per : defAt;
            const d = rf & 0x100 ? dv.getUint32(at) : def;
            if (d > BAD) { if (at >= 0 && !t.bad.some((b) => b.dv === dv && b.at === at)) t.bad.push({ dv, at }); }
            else { t.total += d; t.durs.push(d); }
          }
        }
      }
    }

    const all = Object.values(tracks);
    if (!all.some((t) => t.bad.length)) return blob;

    // Cada muestra dañada recibe el tiempo que le falta a su pista para durar lo mismo que la más larga.
    const secs = Math.max(...all.map((t) => t.total / t.scale));
    for (const t of all) {
      if (!t.bad.length) continue;
      const typical = t.durs.slice().sort((a, b) => a - b)[t.durs.length >> 1] || Math.round(t.scale / 30);
      const gap = Math.round(secs * t.scale) - t.total;
      const each = Math.max(typical, Math.floor(gap / t.bad.length));
      // Sin otra pista que sirva de referencia, cada muestra queda con la duración típica.
      const d = all.length > 1 && gap > 0 ? each : typical;
      for (const b of t.bad) b.dv.setUint32(b.at, d);
    }

    // Se arma el archivo nuevo: los pedazos sin tocar se toman del original.
    const parts = [];
    let prev = 0;
    moofs.forEach((m, i) => { parts.push(blob.slice(prev, m.start), bufs[i].buffer); prev = m.start + m.len; });
    parts.push(blob.slice(prev));
    return new Blob(parts, { type: blob.type });
  }

  globalThis.fixMp4Durations = fixMp4Durations;
})();
