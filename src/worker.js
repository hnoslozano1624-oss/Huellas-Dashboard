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
      'INSERT INTO clientes (nombre, celular, direccion) VALUES (?, ?, ?)'
    ).bind(b.nombre, b.celular ?? null, b.direccion ?? null).run();
    return json({ id: r.meta.last_row_id });
  }

  // --- Pedidos ---
  if (path === 'pedidos' && method === 'GET') {
    const { results } = await env.DB.prepare(
      `SELECT pe.id, pe.fecha, c.nombre AS cliente, u.nombre AS vendedor, pe.canal,
              pe.forma_pago, pe.estado_pago, pe.total
       FROM pedidos pe
       JOIN clientes c ON c.id = pe.cliente_id
       JOIN usuarios u ON u.id = pe.vendedor_id
       ORDER BY pe.fecha DESC`
    ).all();
    const { results: detalles } = await env.DB.prepare(
      `SELECT dp.pedido_id, dp.cantidad, dp.subtotal, p.nombre AS producto, p.categoria
       FROM detalle_pedido dp JOIN productos p ON p.id = dp.producto_id`
    ).all();
    const porPedido = {};
    detalles.forEach(d => {
      if (!porPedido[d.pedido_id]) porPedido[d.pedido_id] = [];
      porPedido[d.pedido_id].push({ producto: d.producto, categoria: d.categoria, cantidad: d.cantidad, valor: d.subtotal });
    });
    results.forEach(p => { p.items = porPedido[p.id] || []; });
    return json(results);
  }
  if (path === 'pedidos' && method === 'POST') {
    const b = await request.json();
    const r = await env.DB.prepare(
      `INSERT INTO pedidos (cliente_id, vendedor_id, canal, forma_pago, observaciones, nombre_peludito, cumple_peludito)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      b.cliente_id, b.vendedor_id, b.canal, b.forma_pago,
      b.observaciones ?? null, b.nombre_peludito ?? null, b.cumple_peludito ?? null
    ).run();
    const pedidoId = r.meta.last_row_id;
    for (const item of b.items || []) {
      const prod = await env.DB.prepare('SELECT precio_unitario FROM productos WHERE id = ?')
        .bind(item.producto_id).first();
      if (!prod) continue;
      const subtotal = prod.precio_unitario * item.cantidad;
      await env.DB.prepare(
        'INSERT INTO detalle_pedido (pedido_id, producto_id, cantidad, precio_unitario, subtotal) VALUES (?, ?, ?, ?, ?)'
      ).bind(pedidoId, item.producto_id, item.cantidad, prod.precio_unitario, subtotal).run();
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

  // --- Órdenes de compra ---
  if (path === 'ordenes-compra' && method === 'GET') {
    const { results } = await env.DB.prepare(
      `SELECT oc.id, oc.fecha, oc.proveedor, oc.producto_id, p.codigo, p.nombre AS producto,
              oc.cantidad, oc.costo_unitario, oc.estado
       FROM ordenes_compra oc JOIN productos p ON p.id = oc.producto_id
       ORDER BY oc.fecha DESC`
    ).all();
    return json(results);
  }
  if (path === 'ordenes-compra' && method === 'POST') {
    const b = await request.json();
    const r = await env.DB.prepare(
      'INSERT INTO ordenes_compra (proveedor, producto_id, cantidad, costo_unitario) VALUES (?, ?, ?, ?)'
    ).bind(b.proveedor, b.producto_id, b.cantidad, b.costo_unitario).run();
    return json({ id: r.meta.last_row_id });
  }
  const recibirMatch = path.match(/^ordenes-compra\/(\d+)\/recibir$/);
  if (recibirMatch && method === 'PATCH') {
    await env.DB.prepare("UPDATE ordenes_compra SET estado = 'recibida' WHERE id = ?")
      .bind(recibirMatch[1]).run();
    return json({ ok: true });
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
    const r = await env.DB.prepare(
      'INSERT INTO flujo_caja (tipo, categoria, monto, descripcion, medio) VALUES (?, ?, ?, ?, ?)'
    ).bind(b.tipo, b.categoria, b.monto, b.descripcion ?? null, b.medio ?? null).run();
    return json({ id: r.meta.last_row_id });
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
