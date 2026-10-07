export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      return handleApi(request, env, url).catch((err) =>
        json({ error: String(err && err.message ? err.message : err) }, 500)
      );
    }
    return env.ASSETS.fetch(request);
  },
};

async function handleApi(request, env, url) {
  const path = url.pathname.replace(/^\/api\/?/, '');
  const method = request.method;

  // --- Productos ---
  if (path === 'productos' && method === 'GET') {
    const { results } = await env.DB.prepare(
      'SELECT * FROM productos WHERE activo = 1 ORDER BY categoria, nombre'
    ).all();
    return json(results);
  }
  if (path === 'productos' && method === 'POST') {
    const b = await request.json();
    // Código automático: sigue el consecutivo HO (el mayor existente + 1)
    let codigo = (b.codigo || '').trim().toUpperCase();
    if (!codigo) {
      const { results: cods } = await env.DB.prepare("SELECT codigo FROM productos WHERE codigo LIKE 'HO%'").all();
      let max = 0;
      cods.forEach(c => { const n = parseInt(String(c.codigo).replace(/^HO/i, ''), 10); if (!isNaN(n) && n > max) max = n; });
      codigo = 'HO' + String(max + 1).padStart(3, '0');
    }
    const r = await env.DB.prepare(
      'INSERT INTO productos (codigo, nombre, categoria, precio_unitario, costo_unitario) VALUES (?, ?, ?, ?, ?)'
    ).bind(codigo, b.nombre, b.categoria, b.precio_unitario ?? 0, b.costo_unitario ?? null).run();
    const productoId = r.meta.last_row_id;
    const cant = Number(b.cantidad_inicial) || 0;
    if (cant > 0) {
      await env.DB.prepare("UPDATE inventario SET cantidad_disponible = cantidad_disponible + ?, actualizado_en = datetime('now') WHERE producto_id = ?").bind(cant, productoId).run();
      await registrarEntrada(env, productoId, cant, b.nota || 'Producto nuevo');
    }
    return json({ id: productoId, codigo });
  }
  const productoIdMatch = path.match(/^productos\/(\d+)$/);
  if (productoIdMatch && method === 'PATCH') {
    const id = productoIdMatch[1];
    const b = await request.json();
    const campos = [];
    const valores = [];
    if ('codigo' in b) { campos.push('codigo = ?'); valores.push(b.codigo || null); }
    if ('costo_unitario' in b) { campos.push('costo_unitario = ?'); valores.push(b.costo_unitario); }
    if ('precio_unitario' in b) { campos.push('precio_unitario = ?'); valores.push(b.precio_unitario); }
    if (campos.length === 0) return json({ error: 'Nada para actualizar' }, 400);
    valores.push(id);
    await env.DB.prepare(`UPDATE productos SET ${campos.join(', ')} WHERE id = ?`).bind(...valores).run();
    return json({ ok: true });
  }

  // --- Inventario ---
  if (path === 'inventario' && method === 'GET') {
    const { results } = await env.DB.prepare(
      `SELECT i.producto_id, p.codigo, p.nombre, p.categoria, i.cantidad_disponible, i.actualizado_en
       FROM inventario i JOIN productos p ON p.id = i.producto_id
       ORDER BY p.categoria, p.nombre`
    ).all();
    return json(results);
  }

  if (path === 'inventario/entrada' && method === 'POST') {
    const b = await request.json();
    const cant = Number(b.cantidad);
    if (!b.producto_id || !cant || cant <= 0) return json({ error: 'Producto y cantidad (mayor a 0) son obligatorios' }, 400);
    const prod = await env.DB.prepare('SELECT id FROM productos WHERE id = ?').bind(b.producto_id).first();
    if (!prod) return json({ error: 'El producto no existe' }, 404);
    await env.DB.prepare("UPDATE inventario SET cantidad_disponible = cantidad_disponible + ?, actualizado_en = datetime('now') WHERE producto_id = ?").bind(cant, b.producto_id).run();
    await registrarEntrada(env, b.producto_id, cant, b.nota || 'Entrada manual');
    const fila = await env.DB.prepare('SELECT cantidad_disponible FROM inventario WHERE producto_id = ?').bind(b.producto_id).first();
    return json({ ok: true, cantidad_disponible: fila ? fila.cantidad_disponible : null });
  }

  // --- Lista de precios: competencia y productos solo de mercado (no tocan el inventario) ---
  if (path === 'competencia' && method === 'GET') {
    await asegurarEsquemaLista(env);
    const { results } = await env.DB.prepare('SELECT * FROM competencia_productos').all();
    return json(results);
  }
  const compMatch = path.match(/^competencia\/(\d+)$/);
  if (compMatch && method === 'PUT') {
    await asegurarEsquemaLista(env);
    const b = await request.json();
    await env.DB.prepare(
      'INSERT OR REPLACE INTO competencia_productos (producto_id, marca, presentacion, laika, agrocampo, ceba, puppys) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).bind(compMatch[1], b.marca ?? null, b.presentacion ?? null, b.laika ?? null, b.agrocampo ?? null, b.ceba ?? null, b.puppys ?? null).run();
    return json({ ok: true });
  }
  if (path === 'lista-mercado' && method === 'GET') {
    await asegurarEsquemaLista(env);
    const { results } = await env.DB.prepare('SELECT * FROM lista_mercado ORDER BY categoria, producto').all();
    return json(results);
  }
  if (path === 'lista-mercado' && method === 'POST') {
    await asegurarEsquemaLista(env);
    const b = await request.json();
    if (!b.categoria || !b.producto) return json({ error: 'Categoría y producto son obligatorios' }, 400);
    const r = await env.DB.prepare(
      'INSERT INTO lista_mercado (categoria, marca, producto, presentacion, costo, precio, laika, agrocampo, ceba, puppys) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(b.categoria, b.marca ?? null, b.producto, b.presentacion ?? null, b.costo ?? null, b.precio ?? null, b.laika ?? null, b.agrocampo ?? null, b.ceba ?? null, b.puppys ?? null).run();
    return json({ id: r.meta.last_row_id });
  }
  const mercMatch = path.match(/^lista-mercado\/(\d+)$/);
  if (mercMatch && method === 'PATCH') {
    await asegurarEsquemaLista(env);
    const b = await request.json();
    const permitidos = ['costo', 'precio', 'laika', 'agrocampo', 'ceba', 'puppys'];
    const campos = [], valores = [];
    permitidos.forEach(k => { if (k in b) { campos.push(k + ' = ?'); valores.push(b[k]); } });
    if (!campos.length) return json({ error: 'Nada para actualizar' }, 400);
    valores.push(mercMatch[1]);
    await env.DB.prepare('UPDATE lista_mercado SET ' + campos.join(', ') + ' WHERE id = ?').bind(...valores).run();
    return json({ ok: true });
  }
  if (mercMatch && method === 'DELETE') {
    await asegurarEsquemaLista(env);
    await env.DB.prepare('DELETE FROM lista_mercado WHERE id = ?').bind(mercMatch[1]).run();
    return json({ ok: true });
  }

  // --- Clientes ---
  if (path === 'clientes' && method === 'GET') {
    const { results } = await env.DB.prepare('SELECT * FROM clientes ORDER BY nombre').all();
    return json(results);
  }
  if (path === 'clientes' && method === 'POST') {
    const b = await request.json();
    // Evita duplicados (p. ej. por doble clic): si ya existe un cliente con el mismo nombre, se devuelve ese
    const normN = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();
    const { results: existentes } = await env.DB.prepare('SELECT id, nombre FROM clientes').all();
    const dup = existentes.find(c => normN(c.nombre) === normN(b.nombre));
    if (dup) return json({ id: dup.id, existente: true });
    const r = await env.DB.prepare(
      'INSERT INTO clientes (nombre, celular, direccion, canal) VALUES (?, ?, ?, ?)'
    ).bind(b.nombre, b.celular ?? null, b.direccion ?? null, b.canal ?? null).run();
    return json({ id: r.meta.last_row_id });
  }
  const clienteIdMatch = path.match(/^clientes\/(\d+)$/);
  if (clienteIdMatch && method === 'PATCH') {
    const id = clienteIdMatch[1];
    const b = await request.json();
    const campos = [];
    const valores = [];
    if ('nombre' in b) { campos.push('nombre = ?'); valores.push(b.nombre); }
    if ('celular' in b) { campos.push('celular = ?'); valores.push(b.celular || null); }
    if ('direccion' in b) { campos.push('direccion = ?'); valores.push(b.direccion || null); }
    if ('canal' in b) { campos.push('canal = ?'); valores.push(b.canal || null); }
    if (campos.length === 0) return json({ error: 'Nada para actualizar' }, 400);
    valores.push(id);
    await env.DB.prepare(`UPDATE clientes SET ${campos.join(', ')} WHERE id = ?`).bind(...valores).run();
    return json({ ok: true });
  }

  const clienteDelMatch = path.match(/^clientes\/(\d+)$/);
  if (clienteDelMatch && method === 'DELETE') {
    const id = clienteDelMatch[1];
    const uso = await env.DB.prepare('SELECT COUNT(*) AS n FROM pedidos WHERE cliente_id = ?').bind(id).first();
    if (uso && uso.n > 0) return json({ error: 'El cliente tiene ' + uso.n + ' pedido(s) registrados y no se puede borrar' }, 409);
    await env.DB.prepare('DELETE FROM clientes WHERE id = ?').bind(id).run();
    return json({ ok: true });
  }

  // --- Pedidos ---
  if (path === 'pedidos' && method === 'GET') {
    const { results } = await env.DB.prepare(
      `SELECT pe.id, pe.fecha, c.nombre AS cliente, u.nombre AS vendedor, pe.canal,
              pe.forma_pago, pe.estado_pago, pe.total, pe.observaciones, pe.cliente_id, pe.vendedor_id
       FROM pedidos pe
       JOIN clientes c ON c.id = pe.cliente_id
       JOIN usuarios u ON u.id = pe.vendedor_id
       ORDER BY pe.fecha DESC`
    ).all();
    const { results: detalles } = await env.DB.prepare(
      `SELECT dp.pedido_id, dp.producto_id, dp.cantidad, dp.precio_unitario, dp.subtotal, p.codigo, p.nombre AS producto, p.categoria
       FROM detalle_pedido dp JOIN productos p ON p.id = dp.producto_id`
    ).all();
    const porPedido = {};
    detalles.forEach(d => {
      if (!porPedido[d.pedido_id]) porPedido[d.pedido_id] = [];
      porPedido[d.pedido_id].push({ producto_id: d.producto_id, codigo: d.codigo, producto: d.producto, categoria: d.categoria, cantidad: d.cantidad, precio_unitario: d.precio_unitario, valor: d.subtotal });
    });
    results.forEach(p => { p.items = porPedido[p.id] || []; });
    return json(results);
  }
  if (path === 'pedidos' && method === 'POST') {
    const b = await request.json();
    const esContado = b.forma_pago === 'Efectivo' || b.forma_pago === 'Transferencia';
    const estadoPago = esContado ? 'pagado' : 'pendiente';
    const fecha = b.fecha || new Date().toISOString().slice(0, 19).replace('T', ' ');
    // Si hay un consecutivo liberado por un pedido eliminado, se reutiliza para no perder la secuencia
    await asegurarTablaConsecutivos(env);
    const libre = await env.DB.prepare(
      'SELECT numero FROM consecutivos_libres WHERE numero NOT IN (SELECT id FROM pedidos) ORDER BY numero ASC LIMIT 1'
    ).first();
    let pedidoId;
    if (libre) {
      await env.DB.prepare(
        `INSERT INTO pedidos (id, fecha, cliente_id, vendedor_id, canal, forma_pago, estado_pago, observaciones, nombre_peludito, cumple_peludito)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        libre.numero, fecha, b.cliente_id, b.vendedor_id, b.canal, b.forma_pago, estadoPago,
        b.observaciones ?? null, b.nombre_peludito ?? null, b.cumple_peludito ?? null
      ).run();
      pedidoId = libre.numero;
    } else {
      const r = await env.DB.prepare(
        `INSERT INTO pedidos (fecha, cliente_id, vendedor_id, canal, forma_pago, estado_pago, observaciones, nombre_peludito, cumple_peludito)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        fecha, b.cliente_id, b.vendedor_id, b.canal, b.forma_pago, estadoPago,
        b.observaciones ?? null, b.nombre_peludito ?? null, b.cumple_peludito ?? null
      ).run();
      pedidoId = r.meta.last_row_id;
    }
    await env.DB.prepare('DELETE FROM consecutivos_libres WHERE numero = ?').bind(pedidoId).run();
    for (const item of b.items || []) {
      const prod = await env.DB.prepare('SELECT precio_unitario FROM productos WHERE id = ?')
        .bind(item.producto_id).first();
      if (!prod) continue;
      const precioUsado = (item.precio_unitario != null) ? item.precio_unitario : prod.precio_unitario;
      const subtotal = precioUsado * item.cantidad;
      await env.DB.prepare(
        'INSERT INTO detalle_pedido (pedido_id, producto_id, cantidad, precio_unitario, subtotal) VALUES (?, ?, ?, ?, ?)'
      ).bind(pedidoId, item.producto_id, item.cantidad, precioUsado, subtotal).run();
    }
    return json({ id: pedidoId });
  }
  const estadoPagoMatch = path.match(/^pedidos\/(\d+)\/estado-pago$/);
  if (estadoPagoMatch && method === 'PATCH') {
    const b = await request.json();
    await env.DB.prepare('UPDATE pedidos SET estado_pago = ? WHERE id = ?')
      .bind(b.estado_pago, estadoPagoMatch[1]).run();
    return json({ ok: true });
  }
  const pedidoPutMatch = path.match(/^pedidos\/(\d+)$/);
  if (pedidoPutMatch && method === 'PUT') {
    // Edita un pedido existente conservando su número: actualiza encabezado y reemplaza el detalle
    const id = Number(pedidoPutMatch[1]);
    const b = await request.json();
    const previo = await env.DB.prepare('SELECT forma_pago, estado_pago, fecha FROM pedidos WHERE id = ?').bind(id).first();
    if (!previo) return json({ error: 'El pedido no existe' }, 404);
    const esContado = b.forma_pago === 'Efectivo' || b.forma_pago === 'Transferencia';
    const eraContado = previo.forma_pago === 'Efectivo' || previo.forma_pago === 'Transferencia';
    const estadoPago = esContado ? 'pagado' : (eraContado ? 'pendiente' : previo.estado_pago);
    await env.DB.prepare(
      `UPDATE pedidos SET fecha = ?, cliente_id = ?, vendedor_id = ?, canal = ?, forma_pago = ?, estado_pago = ?, observaciones = ? WHERE id = ?`
    ).bind(b.fecha || previo.fecha, b.cliente_id, b.vendedor_id, b.canal, b.forma_pago, estadoPago, b.observaciones ?? null, id).run();
    await env.DB.prepare('DELETE FROM detalle_pedido WHERE pedido_id = ?').bind(id).run();
    for (const item of b.items || []) {
      const prod = await env.DB.prepare('SELECT precio_unitario FROM productos WHERE id = ?').bind(item.producto_id).first();
      if (!prod) continue;
      const precioUsado = (item.precio_unitario != null) ? item.precio_unitario : prod.precio_unitario;
      await env.DB.prepare(
        'INSERT INTO detalle_pedido (pedido_id, producto_id, cantidad, precio_unitario, subtotal) VALUES (?, ?, ?, ?, ?)'
      ).bind(id, item.producto_id, item.cantidad, precioUsado, precioUsado * item.cantidad).run();
    }
    // El ingreso de caja ligado al pedido se rehace con el nuevo total
    await env.DB.prepare('DELETE FROM flujo_caja WHERE pedido_id = ?').bind(id).run();
    return json({ id, editado: true });
  }
  const pedidoDeleteMatch = path.match(/^pedidos\/(\d+)$/);
  if (pedidoDeleteMatch && method === 'DELETE') {
    const id = pedidoDeleteMatch[1];
    await env.DB.prepare('DELETE FROM flujo_caja WHERE pedido_id = ?').bind(id).run();
    await env.DB.prepare('DELETE FROM abonos WHERE pedido_id = ?').bind(id).run();
    await env.DB.prepare('DELETE FROM detalle_pedido WHERE pedido_id = ?').bind(id).run();
    await env.DB.prepare('DELETE FROM pedidos WHERE id = ?').bind(id).run();
    await asegurarTablaConsecutivos(env);
    await env.DB.prepare('INSERT OR IGNORE INTO consecutivos_libres (numero) VALUES (?)').bind(Number(id)).run();
    const seqRow = await env.DB.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'pedidos'").first();
    if (seqRow && Number(seqRow.seq) === Number(id)) {
      await env.DB.prepare("UPDATE sqlite_sequence SET seq = seq - 1 WHERE name = 'pedidos'").run();
    }
    return json({ ok: true, consecutivo_liberado: seqRow && Number(seqRow.seq) === Number(id) });
  }
  const pedidoManualMatch = path.match(/^pedidos\/manual$/);
  if (pedidoManualMatch && method === 'POST') {
    // Crea un pedido con un número específico (para rellenar un hueco en la numeración)
    const b = await request.json();
    const esContado = b.forma_pago === 'Efectivo' || b.forma_pago === 'Transferencia';
    const estadoPago = esContado ? 'pagado' : 'pendiente';
    const fecha = b.fecha || new Date().toISOString().slice(0, 19).replace('T', ' ');
    const existente = await env.DB.prepare('SELECT id FROM pedidos WHERE id = ?').bind(b.numero).first();
    if (existente) return json({ error: 'Ya existe un pedido con ese número' }, 400);
    await env.DB.prepare(
      `INSERT INTO pedidos (id, fecha, cliente_id, vendedor_id, canal, forma_pago, estado_pago, observaciones, nombre_peludito, cumple_peludito)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      b.numero, fecha, b.cliente_id, b.vendedor_id, b.canal, b.forma_pago, estadoPago,
      b.observaciones ?? null, b.nombre_peludito ?? null, b.cumple_peludito ?? null
    ).run();
    const pedidoId = b.numero;
    for (const item of b.items || []) {
      const prod = await env.DB.prepare('SELECT precio_unitario FROM productos WHERE id = ?')
        .bind(item.producto_id).first();
      if (!prod) continue;
      const precioUsado = (item.precio_unitario != null) ? item.precio_unitario : prod.precio_unitario;
      const subtotal = precioUsado * item.cantidad;
      await env.DB.prepare(
        'INSERT INTO detalle_pedido (pedido_id, producto_id, cantidad, precio_unitario, subtotal) VALUES (?, ?, ?, ?, ?)'
      ).bind(pedidoId, item.producto_id, item.cantidad, precioUsado, subtotal).run();
    }
    return json({ id: pedidoId });
  }

  // --- Órdenes de compra ---
  if (path === 'ordenes-compra' && method === 'GET') {
    await asegurarEsquemaOc(env);
    const { results } = await env.DB.prepare(
      `SELECT oc.id, oc.fecha, oc.proveedor, oc.producto_id, p.codigo, p.nombre AS producto, p.categoria,
              oc.cantidad, oc.costo_unitario, oc.estado, oc.fecha_vencimiento, oc.oc_numero, oc.cuenta_pago
       FROM ordenes_compra oc JOIN productos p ON p.id = oc.producto_id
       ORDER BY oc.fecha DESC, oc.id DESC`
    ).all();
    return json(results);
  }
  if (path === 'proveedores' && method === 'GET') {
    await asegurarEsquemaOc(env);
    const { results } = await env.DB.prepare(
      `SELECT nombre, celular, direccion FROM proveedores
       UNION SELECT DISTINCT proveedor, NULL, NULL FROM ordenes_compra WHERE proveedor IS NOT NULL AND proveedor NOT IN (SELECT nombre FROM proveedores)
       ORDER BY 1`
    ).all();
    return json(results);
  }
  if (path === 'ordenes-compra/lote' && method === 'POST') {
    await asegurarEsquemaOc(env);
    const b = await request.json();
    const items = (b.items || []).filter(it => it.producto_id && Number(it.cantidad) > 0);
    if (!b.proveedor || !items.length) return json({ error: 'Proveedor y al menos un producto son obligatorios' }, 400);
    const cuenta = b.cuenta_pago === 'Bancos' ? 'Bancos' : 'Efectivo';
    let numero = b.oc_numero || null;
    if (numero) {
      // Edición: se devuelve al inventario lo que había entrado y se reemplazan las líneas
      const { results: viejas } = await env.DB.prepare('SELECT id, producto_id, cantidad, estado, fecha FROM ordenes_compra WHERE oc_numero = ?').bind(numero).all();
      if (!viejas.length) return json({ error: 'La orden no existe' }, 404);
      for (const v of viejas) {
        if (v.estado === 'recibida') {
          await env.DB.prepare("UPDATE inventario SET cantidad_disponible = cantidad_disponible - ?, actualizado_en = datetime('now') WHERE producto_id = ?").bind(v.cantidad, v.producto_id).run();
        }
      }
      await env.DB.prepare('DELETE FROM ordenes_compra WHERE oc_numero = ?').bind(numero).run();
      await env.DB.prepare('DELETE FROM flujo_caja WHERE oc_numero = ?').bind(numero).run();
      if (!b.fecha) b.fecha = viejas[0].fecha;
    } else {
      numero = await siguienteNumeroOc(env);
    }
    const fecha = b.fecha || new Date().toISOString().slice(0, 19).replace('T', ' ');
    await env.DB.prepare('INSERT OR IGNORE INTO proveedores (nombre, celular, direccion) VALUES (?, ?, ?)').bind(b.proveedor, b.celular ?? null, b.direccion ?? null).run();
    let total = 0;
    for (const it of items) {
      const costo = Number(it.costo_unitario) || 0;
      total += costo * Number(it.cantidad);
      const r = await env.DB.prepare(
        "INSERT INTO ordenes_compra (fecha, proveedor, producto_id, cantidad, costo_unitario, estado, fecha_vencimiento, oc_numero, cuenta_pago) VALUES (?, ?, ?, ?, ?, 'pendiente', ?, ?, ?)"
      ).bind(fecha, b.proveedor, it.producto_id, it.cantidad, costo, it.fecha_vencimiento ?? null, numero, cuenta).run();
      await env.DB.prepare("UPDATE ordenes_compra SET estado = 'recibida' WHERE id = ?").bind(r.meta.last_row_id).run();
      if (costo > 0) await env.DB.prepare('UPDATE productos SET costo_unitario = ? WHERE id = ?').bind(costo, it.producto_id).run();
    }
    if (total > 0) {
      await env.DB.prepare(
        "INSERT INTO flujo_caja (fecha, tipo, categoria, monto, descripcion, medio, oc_numero) VALUES (?, 'gasto', ?, ?, ?, ?, ?)"
      ).bind(fecha, cuenta, total, 'Compra a proveedor — ' + b.proveedor + ' (' + numero + ')', cuenta, numero).run();
    }
    return json({ oc_numero: numero, total });
  }
  if (path === 'ordenes-compra' && method === 'POST') {
    const b = await request.json();
    const r = await env.DB.prepare(
      'INSERT INTO ordenes_compra (proveedor, producto_id, cantidad, costo_unitario, fecha_vencimiento) VALUES (?, ?, ?, ?, ?)'
    ).bind(b.proveedor, b.producto_id, b.cantidad, b.costo_unitario, b.fecha_vencimiento ?? null).run();
    return json({ id: r.meta.last_row_id });
  }
  const recibirMatch = path.match(/^ordenes-compra\/(\d+)\/recibir$/);
  if (recibirMatch && method === 'PATCH') {
    await env.DB.prepare("UPDATE ordenes_compra SET estado = 'recibida' WHERE id = ?")
      .bind(recibirMatch[1]).run();
    return json({ ok: true });
  }
  if (path === 'vencidos' && method === 'GET') {
    const { results } = await env.DB.prepare(
      `SELECT oc.id, oc.fecha, p.codigo, p.nombre AS producto, p.categoria, oc.cantidad, oc.fecha_vencimiento,
              CAST(julianday(oc.fecha_vencimiento) - julianday('now') AS INTEGER) AS dias_restantes
       FROM ordenes_compra oc JOIN productos p ON p.id = oc.producto_id
       WHERE oc.estado = 'recibida' AND oc.fecha_vencimiento IS NOT NULL
         AND julianday(oc.fecha_vencimiento) - julianday('now') <= 90
       ORDER BY oc.fecha_vencimiento ASC`
    ).all();
    return json(results);
  }

  // --- Cartera (saldo por pedido) y abonos ---
  if (path === 'cartera' && method === 'GET') {
    const { results } = await env.DB.prepare(
      `SELECT pe.id, pe.fecha, c.nombre AS cliente, u.nombre AS vendedor, pe.forma_pago, pe.total,
              COALESCE((SELECT SUM(monto) FROM abonos WHERE pedido_id = pe.id), 0) AS abonado
       FROM pedidos pe
       JOIN clientes c ON c.id = pe.cliente_id
       JOIN usuarios u ON u.id = pe.vendedor_id
       WHERE pe.estado_pago = 'pendiente'
         AND pe.forma_pago NOT IN ('Efectivo', 'Transferencia')
       ORDER BY pe.fecha ASC`
    ).all();
    results.forEach(r => { r.saldo = r.total - r.abonado; });
    return json(results);
  }
  const saldarMatch = path.match(/^pedidos\/(\d+)\/saldar-sin-caja$/);
  if (saldarMatch && method === 'POST') {
    // Marca un pedido a crédito como pagado SIN registrar ingreso en caja (se cobró antes y ya está en el saldo de caja)
    const id = Number(saldarMatch[1]);
    const ped = await env.DB.prepare(
      `SELECT pe.total, pe.forma_pago, pe.estado_pago, COALESCE((SELECT SUM(monto) FROM abonos WHERE pedido_id = pe.id), 0) AS abonado FROM pedidos pe WHERE pe.id = ?`
    ).bind(id).first();
    if (!ped) return json({ error: 'El pedido no existe' }, 404);
    if (ped.forma_pago === 'Efectivo' || ped.forma_pago === 'Transferencia') return json({ error: 'Solo los pedidos a crédito están en cartera' }, 400);
    if (ped.estado_pago === 'pagado') return json({ error: 'El pedido ya está pagado' }, 409);
    await env.DB.prepare('CREATE TABLE IF NOT EXISTS saldos_sin_caja (id INTEGER PRIMARY KEY AUTOINCREMENT, pedido_id INTEGER NOT NULL, saldo REAL NOT NULL, nota TEXT, fecha TEXT NOT NULL DEFAULT (datetime(\'now\')))').run();
    const b = await request.json().catch(() => ({}));
    await env.DB.prepare('INSERT INTO saldos_sin_caja (pedido_id, saldo, nota) VALUES (?, ?, ?)').bind(id, ped.total - ped.abonado, b.nota || 'Cobrado antes; sin movimiento de caja').run();
    await env.DB.prepare("UPDATE pedidos SET estado_pago = 'pagado' WHERE id = ?").bind(id).run();
    return json({ ok: true, saldo_saldado: ped.total - ped.abonado });
  }
  const abonosMatch = path.match(/^pedidos\/(\d+)\/abonos$/);
  if (abonosMatch && method === 'GET') {
    const { results } = await env.DB.prepare(
      'SELECT id, monto, medio, fecha FROM abonos WHERE pedido_id = ? ORDER BY fecha ASC'
    ).bind(abonosMatch[1]).all();
    return json(results);
  }
  if (abonosMatch && method === 'POST') {
    const b = await request.json();
    const r = await env.DB.prepare(
      'INSERT INTO abonos (pedido_id, monto, medio) VALUES (?, ?, ?)'
    ).bind(abonosMatch[1], b.monto, b.medio).run();
    const pedido = await env.DB.prepare(
      `SELECT pe.total, COALESCE((SELECT SUM(monto) FROM abonos WHERE pedido_id = pe.id), 0) AS abonado, pe.estado_pago
       FROM pedidos pe WHERE pe.id = ?`
    ).bind(abonosMatch[1]).first();
    return json({ id: r.meta.last_row_id, saldo: pedido.total - pedido.abonado, estado_pago: pedido.estado_pago });
  }

  // --- Flujo de caja ---
  if (path === 'flujo-caja' && method === 'GET') {
    const { results } = await env.DB.prepare('SELECT * FROM flujo_caja ORDER BY fecha DESC').all();
    return json(results);
  }
  if (path === 'flujo-caja' && method === 'POST') {
    const b = await request.json();
    const campos = ['tipo', 'categoria', 'monto', 'descripcion', 'medio', 'pedido_id'];
    const valores = [b.tipo, b.categoria, b.monto, b.descripcion ?? null, b.medio ?? null, b.pedido_id ?? null];
    if (b.fecha) { campos.push('fecha'); valores.push(b.fecha); }
    const r = await env.DB.prepare(
      `INSERT INTO flujo_caja (${campos.join(',')}) VALUES (${campos.map(() => '?').join(',')})`
    ).bind(...valores).run();
    return json({ id: r.meta.last_row_id });
  }

  // --- Cotizaciones (historial permanente) ---
  if (path.startsWith('cotizaciones')) {
    await env.DB.prepare('CREATE TABLE IF NOT EXISTS cotizaciones (cot_num TEXT PRIMARY KEY, nombre TEXT, fecha TEXT, total REAL, datos TEXT NOT NULL, creado_en TEXT NOT NULL DEFAULT (datetime(\'now\')), actualizado_en TEXT NOT NULL DEFAULT (datetime(\'now\')))').run();
    const numDe = (c) => parseInt(String(c).replace(/\D/g, ''), 10) || 0;
    if (path === 'cotizaciones' && method === 'GET') {
      const { results } = await env.DB.prepare('SELECT cot_num, datos FROM cotizaciones ORDER BY creado_en ASC, cot_num ASC').all();
      const lista = results.map(r => { try { return JSON.parse(r.datos); } catch (e) { return null; } }).filter(Boolean);
      return json(lista);
    }
    if (path === 'cotizaciones/siguiente' && method === 'GET') {
      const { results } = await env.DB.prepare('SELECT cot_num FROM cotizaciones').all();
      const max = results.reduce((m, r) => Math.max(m, numDe(r.cot_num)), 0);
      return json({ numero: max + 1 });
    }
    if (path === 'cotizaciones' && method === 'POST') {
      const b = await request.json();
      if (!b.cot_num || !b.datos) return json({ error: 'Faltan datos de la cotización' }, 400);
      const ya = await env.DB.prepare('SELECT cot_num FROM cotizaciones WHERE cot_num = ?').bind(b.cot_num).first();
      if (ya) return json({ error: 'Ya existe una cotización con el número ' + b.cot_num }, 409);
      await env.DB.prepare('INSERT INTO cotizaciones (cot_num, nombre, fecha, total, datos) VALUES (?, ?, ?, ?, ?)')
        .bind(b.cot_num, b.nombre ?? null, b.fecha ?? null, b.total ?? 0, JSON.stringify(b.datos)).run();
      return json({ ok: true, cot_num: b.cot_num });
    }
    const cotMatch = path.match(/^cotizaciones\/([^/]+)$/);
    if (cotMatch && method === 'PUT') {
      const num = decodeURIComponent(cotMatch[1]);
      const b = await request.json();
      if (!b.datos) return json({ error: 'Faltan datos de la cotización' }, 400);
      await env.DB.prepare(
        `INSERT INTO cotizaciones (cot_num, nombre, fecha, total, datos) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(cot_num) DO UPDATE SET nombre = excluded.nombre, fecha = excluded.fecha, total = excluded.total, datos = excluded.datos, actualizado_en = datetime('now')`
      ).bind(num, b.nombre ?? null, b.fecha ?? null, b.total ?? 0, JSON.stringify(b.datos)).run();
      return json({ ok: true, cot_num: num });
    }
  }

  // --- Cierres de mes ---
  if (path === 'cierres' && method === 'GET') {
    const { results } = await env.DB.prepare('SELECT mes, fecha_cierre FROM cierres_mes ORDER BY mes DESC').all();
    return json(results);
  }
  if (path === 'cierres' && method === 'POST') {
    const b = await request.json();
    if (!b.mes) return json({ error: 'Falta el mes (formato YYYY-MM)' }, 400);
    const existente = await env.DB.prepare('SELECT mes FROM cierres_mes WHERE mes = ?').bind(b.mes).first();
    if (existente) return json({ error: 'Ese mes ya está cerrado' }, 400);
    await env.DB.prepare('INSERT INTO cierres_mes (mes) VALUES (?)').bind(b.mes).run();
    return json({ ok: true });
  }

  // --- Usuarios / login ---
  if (path === 'usuarios' && method === 'GET') {
    const { results } = await env.DB.prepare(
      'SELECT id, nombre, usuario, rol FROM usuarios WHERE activo = 1 ORDER BY nombre'
    ).all();
    return json(results);
  }
  if (path === 'usuarios' && method === 'POST') {
    const b = await request.json();
    const hash = await sha256(b.password);
    const r = await env.DB.prepare(
      'INSERT INTO usuarios (nombre, usuario, password_hash, rol) VALUES (?, ?, ?, ?)'
    ).bind(b.nombre, b.usuario, hash, b.rol).run();
    return json({ id: r.meta.last_row_id });
  }
  if (path === 'login' && method === 'POST') {
    const b = await request.json();
    const hash = await sha256(b.password);
    const user = await env.DB.prepare(
      'SELECT id, nombre, usuario, rol FROM usuarios WHERE usuario = ? AND password_hash = ? AND activo = 1'
    ).bind(b.usuario, hash).first();
    if (!user) return json({ error: 'Usuario o contraseña incorrectos' }, 401);
    return json(user);
  }

  return json({ error: 'Ruta no encontrada' }, 404);
}

async function sha256(text) {
  const data = new TextEncoder().encode(text || '');
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}


// Consecutivos de pedidos eliminados: el siguiente pedido nuevo reutiliza el más bajo disponible
async function asegurarTablaConsecutivos(env) {
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS consecutivos_libres (numero INTEGER PRIMARY KEY)').run();
}

// Historial de entradas de inventario (se crea sola la primera vez que se usa)
async function registrarEntrada(env, productoId, cantidad, nota) {
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS entradas_inventario (id INTEGER PRIMARY KEY AUTOINCREMENT, fecha TEXT NOT NULL DEFAULT (datetime(\'now\')), producto_id INTEGER NOT NULL, cantidad INTEGER NOT NULL, nota TEXT)').run();
  await env.DB.prepare('INSERT INTO entradas_inventario (producto_id, cantidad, nota) VALUES (?, ?, ?)').bind(productoId, cantidad, nota ?? null).run();
}

// ---- Esquema de órdenes de compra (agrupadas por número) ----
let esquemaOcListo = false;
async function asegurarEsquemaOc(env) {
  if (esquemaOcListo) return;
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS proveedores (id INTEGER PRIMARY KEY AUTOINCREMENT, nombre TEXT NOT NULL UNIQUE, celular TEXT, direccion TEXT)').run();
  for (const sql of [
    'ALTER TABLE ordenes_compra ADD COLUMN oc_numero TEXT',
    'ALTER TABLE ordenes_compra ADD COLUMN cuenta_pago TEXT',
    'ALTER TABLE flujo_caja ADD COLUMN oc_numero TEXT'
  ]) {
    try { await env.DB.prepare(sql).run(); } catch (e) { /* la columna ya existe */ }
  }
  // Líneas antiguas sin número: se agrupan por proveedor y por cercanía en el tiempo (misma compra guardada de una vez)
  const { results: sinNumero } = await env.DB.prepare('SELECT id, fecha, proveedor FROM ordenes_compra WHERE oc_numero IS NULL ORDER BY id').all();
  if (sinNumero.length) {
    let n = await ultimoNumeroOc(env);
    let anterior = null, actual = null;
    for (const l of sinNumero) {
      const t = Date.parse(String(l.fecha).replace(' ', 'T') + 'Z');
      if (!anterior || anterior.proveedor !== l.proveedor || (t - anterior.t) > 30000) { n += 1; actual = 'OC-' + String(n).padStart(4, '0'); }
      await env.DB.prepare('UPDATE ordenes_compra SET oc_numero = ?, cuenta_pago = COALESCE(cuenta_pago, ?) WHERE id = ?').bind(actual, 'Efectivo', l.id).run();
      anterior = { proveedor: l.proveedor, t };
    }
  }
  esquemaOcListo = true;
}
async function ultimoNumeroOc(env) {
  const { results } = await env.DB.prepare("SELECT oc_numero FROM ordenes_compra WHERE oc_numero LIKE 'OC-%'").all();
  let max = 0;
  results.forEach(r => { const n = parseInt(String(r.oc_numero).slice(3), 10); if (!isNaN(n) && n > max) max = n; });
  return max;
}
async function siguienteNumeroOc(env) {
  return 'OC-' + String((await ultimoNumeroOc(env)) + 1).padStart(4, '0');
}

// ---- Esquema de la lista de precios (competencia y productos solo de mercado) ----
let esquemaListaListo = false;
async function asegurarEsquemaLista(env) {
  if (esquemaListaListo) return;
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS competencia_productos (producto_id INTEGER PRIMARY KEY, marca TEXT, presentacion TEXT, laika REAL, agrocampo REAL, ceba REAL, puppys REAL)').run();
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS lista_mercado (id INTEGER PRIMARY KEY AUTOINCREMENT, categoria TEXT NOT NULL, marca TEXT, producto TEXT NOT NULL, presentacion TEXT, costo REAL, precio REAL, laika REAL, agrocampo REAL, ceba REAL, puppys REAL)').run();
  esquemaListaListo = true;
}
