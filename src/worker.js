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

  // --- Inventario ---
  if (path === 'inventario' && method === 'GET') {
    const { results } = await env.DB.prepare(
      `SELECT i.producto_codigo, p.nombre, p.categoria, i.cantidad_disponible, i.actualizado_en
       FROM inventario i JOIN productos p ON p.codigo = i.producto_codigo
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
      const prod = await env.DB.prepare('SELECT precio_unitario FROM productos WHERE codigo = ?')
        .bind(item.producto_codigo).first();
      if (!prod) continue;
      const subtotal = prod.precio_unitario * item.cantidad;
      await env.DB.prepare(
        'INSERT INTO detalle_pedido (pedido_id, producto_codigo, cantidad, precio_unitario, subtotal) VALUES (?, ?, ?, ?, ?)'
      ).bind(pedidoId, item.producto_codigo, item.cantidad, prod.precio_unitario, subtotal).run();
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
    const { results } = await env.DB.prepare('SELECT * FROM ordenes_compra ORDER BY fecha DESC').all();
    return json(results);
  }
  if (path === 'ordenes-compra' && method === 'POST') {
    const b = await request.json();
    const r = await env.DB.prepare(
      'INSERT INTO ordenes_compra (proveedor, producto_codigo, cantidad, costo_unitario) VALUES (?, ?, ?, ?)'
    ).bind(b.proveedor, b.producto_codigo, b.cantidad, b.costo_unitario).run();
    return json({ id: r.meta.last_row_id });
  }
  const recibirMatch = path.match(/^ordenes-compra\/(\d+)\/recibir$/);
  if (recibirMatch && method === 'PATCH') {
    await env.DB.prepare("UPDATE ordenes_compra SET estado = 'recibida' WHERE id = ?")
      .bind(recibirMatch[1]).run();
    return json({ ok: true });
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
