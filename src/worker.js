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
    await env.DB.prepare(
      'INSERT INTO productos (codigo, nombre, categoria, precio_unitario, costo_unitario) VALUES (?, ?, ?, ?, ?)'
    ).bind(b.codigo, b.nombre, b.categoria, b.precio_unitario, b.costo_unitario ?? null).run();
    return json({ codigo: b.codigo });
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

  // --- Clientes ---
  if (path === 'clientes' && method === 'GET') {
    const { results } = await env.DB.prepare('SELECT * FROM clientes ORDER BY nombre').all();
    return json(results);
  }
  if (path === 'clientes' && method === 'POST') {
    const b = await request.json();
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
    const { results } = await env.DB.prepare(
      `SELECT oc.id, oc.fecha, oc.proveedor, oc.producto_id, p.codigo, p.nombre AS producto,
              oc.cantidad, oc.costo_unitario, oc.estado, oc.fecha_vencimiento
       FROM ordenes_compra oc JOIN productos p ON p.id = oc.producto_id
       ORDER BY oc.fecha DESC`
    ).all();
    return json(results);
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
       ORDER BY pe.fecha ASC`
    ).all();
    results.forEach(r => { r.saldo = r.total - r.abonado; });
    return json(results);
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
