import { Router } from 'express';
import { supabase } from '../lib/supabase.js';
import { optionalAuth, authenticate } from '../middleware/auth.js';
import jwt from 'jsonwebtoken';

const router = Router();

const isUUID = (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

function getDownloadToken(req) {
  const headerToken = req.headers['x-download-token'];
  if (typeof headerToken === 'string' && headerToken.trim()) return headerToken.trim();
  if (Array.isArray(headerToken) && headerToken[0]) return String(headerToken[0]);
  if (typeof req.query.token === 'string' && req.query.token.trim()) return req.query.token.trim();
  return null;
}

async function getVipAccess({ templateId, userId, token }) {
  if (userId) {
    const { data } = await supabase
      .from('download_access')
      .select('id, remaining_downloads')
      .eq('user_id', userId)
      .eq('template_id', templateId)
      .maybeSingle();
    if (data && (data.remaining_downloads || 0) > 0) return data;
  }
  if (token) {
    const { data } = await supabase
      .from('download_access')
      .select('id, remaining_downloads')
      .eq('token', token)
      .eq('template_id', templateId)
      .maybeSingle();
    if (data) return data;
  }
  if (userId) {
    const { data } = await supabase
      .from('download_access')
      .select('id, remaining_downloads')
      .eq('user_id', userId)
      .eq('template_id', templateId)
      .maybeSingle();
    if (data) return data;
  }
  return null;
}

async function safeRpc(name, params) {
  try {
    const result = await supabase.rpc(name, params);
    if (result.error) console.warn(`RPC ${name} warning:`, result.error.message);
  } catch (e) {
    console.warn(`RPC ${name} failed:`, e.message);
  }
}

// GET /api/templates
router.get('/', async (req, res) => {
  try {
    const { category, search, page = 1, limit = 12 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    let query = supabase
      .from('templates')
      .select('*, users(username, avatar_url, role)', { count: 'exact' })
      .eq('published', true)
      .order('created_at', { ascending: false });

    if (category && category !== 'todos') {
      if (category === 'gratis') query = query.eq('type', 'gratis');
      else if (category === 'vip') query = query.eq('type', 'vip');
      else query = query.eq('category', category);
    }
    if (search) query = query.ilike('title', `%${search}%`);

    const { data: templates, error, count } = await query.range(offset, offset + parseInt(limit) - 1);
    if (error) {
      console.error('Supabase error:', error.message);
      // Devolver array vacío en lugar de 500 para no romper el frontend
      return res.json({ templates: [], total: 0, page: parseInt(page), limit: parseInt(limit), error: error.message });
    }

    res.json({ templates: templates || [], total: count || 0, page: parseInt(page), limit: parseInt(limit) });
  } catch (err) {
    console.error('List error:', err.message);
    res.status(500).json({ error: 'Error al obtener plantillas: ' + err.message });
  }
});

// GET /api/templates/:id/access
router.get('/:id/access', optionalAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const token = getDownloadToken(req);

    const { data: template, error } = await supabase
      .from('templates')
      .select('id, type')
      .eq(isUUID(id) ? 'id' : 'slug', id)
      .maybeSingle();

    if (error) return res.status(500).json({ error: 'Error de base de datos: ' + error.message });
    if (!template) return res.status(404).json({ error: 'Plantilla no encontrada' });

    if (template.type !== 'vip') {
      return res.json({ hasAccess: true, remaining: null });
    }

    const access = await getVipAccess({
      templateId: template.id,
      userId: req.user?.id,
      token,
    });

    const remaining = access?.remaining_downloads || 0;
    res.json({ hasAccess: remaining > 0, remaining });
  } catch (err) {
    res.status(500).json({ error: 'Error al verificar acceso: ' + err.message });
  }
});

// GET /api/templates/:id/download  — MUST BE BEFORE /:slug
router.get('/:id/download', optionalAuth, async (req, res) => {
  try {
    const { id } = req.params;
    console.log(`📥 Descarga: ${id}`);

    const token = getDownloadToken(req);

    const { data: template, error } = await supabase
      .from('templates')
      .select('id, type, file_path, file_url, title')
      .eq(isUUID(id) ? 'id' : 'slug', id)
      .maybeSingle();

    if (error) return res.status(500).json({ error: 'Error de base de datos: ' + error.message });
    if (!template) return res.status(404).json({ error: 'Plantilla no encontrada' });

    if (template.type === 'vip') {
      const access = await getVipAccess({
        templateId: template.id,
        userId: req.user?.id,
        token,
      });

      if (!access || (access.remaining_downloads || 0) < 1) {
        return res.status(403).json({ error: 'Pago requerido o límite de descargas alcanzado' });
      }

      const newRemaining = Math.max((access.remaining_downloads || 0) - 1, 0);
      await supabase.from('download_access')
        .update({ remaining_downloads: newRemaining })
        .eq('id', access.id);
    }

    await safeRpc('increment_downloads', { template_id: template.id });

    let downloadUrl = template.file_url || null;

    if (template.file_path) {
      const { data: pub } = supabase.storage.from('templates').getPublicUrl(template.file_path);
      if (pub?.publicUrl && !pub.publicUrl.includes('undefined') && !pub.publicUrl.includes('null')) {
        downloadUrl = pub.publicUrl;
      }
      if (!downloadUrl) {
        const { data: signed } = await supabase.storage.from('templates').createSignedUrl(template.file_path, 7200);
        if (signed?.signedUrl) downloadUrl = signed.signedUrl;
      }
    }

    if (!downloadUrl) return res.status(404).json({ error: 'Archivo no disponible' });

    console.log(`✅ Descarga OK: ${template.title}`);
    res.json({ downloadUrl, title: template.title });
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener enlace: ' + err.message });
  }
});

// POST /api/templates/:id/like
router.post('/:id/like', authenticate, async (req, res) => {
  try {
    const { id } = req.params;

    const { data: existing } = await supabase.from('likes').select('id').eq('user_id', req.user.id).eq('template_id', id).maybeSingle();

    if (existing) {
      await supabase.from('likes').delete().eq('id', existing.id);
      await safeRpc('decrement_likes', { template_id: id });
      return res.json({ liked: false });
    } else {
      await supabase.from('likes').insert({ user_id: req.user.id, template_id: id });
      await safeRpc('increment_likes', { template_id: id });
      return res.json({ liked: true });
    }
  } catch (err) {
    res.status(500).json({ error: 'Error al procesar like' });
  }
});

// POST /api/templates/:id/purchase
router.post('/:id/purchase', optionalAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { method, amount } = req.body;

    const { data: template } = await supabase.from('templates').select('id, title, price, type').eq('id', id).single();
    if (!template) return res.status(404).json({ error: 'Plantilla no encontrada' });

    await supabase.from('purchases').insert({
      user_id: req.user?.id || null,
      template_id: id,
      amount: amount || template.price,
      method: method || 'unknown',
      status: 'confirmed',
    });

    res.json({ success: true, message: 'Compra registrada' });
  } catch (err) {
    console.error('Purchase error:', err.message);
    res.status(500).json({ error: 'Error al registrar compra' });
  }
});

// PATCH /api/templates/:id/price (admin only)
router.patch('/:id/price', async (req, res) => {
  try {
    const auth = req.headers.authorization?.replace('Bearer ', '');
    if (!auth) return res.status(401).json({ error: 'Autenticación requerida' });

    let decoded;
    try {
      decoded = jwt.verify(auth, process.env.JWT_SECRET);
    } catch {
      return res.status(401).json({ error: 'Token inválido' });
    }
    if (decoded.role !== 'admin') return res.status(403).json({ error: 'Solo el administrador puede cambiar precios' });

    const { id } = req.params;
    const { price, type } = req.body;
    const updateData = {};

    if (price !== undefined) updateData.price = parseFloat(price) || null;
    if (type !== undefined && (type === 'gratis' || type === 'vip')) {
      updateData.type = type;
      if (type === 'gratis') updateData.price = null;
    }

    const { data, error } = await supabase.from('templates').update(updateData).eq('id', id).select('id, title, type, price').single();
    if (error) throw error;
    res.json({ success: true, template: data });
  } catch (err) {
    res.status(500).json({ error: 'Error al actualizar precio: ' + err.message });
  }
});

// GET /api/templates/:slug — MUST BE LAST
router.get('/:slug', optionalAuth, async (req, res) => {
  try {
    const { slug } = req.params;
    console.log(`🔍 Buscando: ${slug}`);

    const { data: template, error } = await supabase
      .from('templates')
      .select('*, users(username, avatar_url, role)')
      .eq(isUUID(slug) ? 'id' : 'slug', slug)
      .maybeSingle();

    if (error) return res.status(500).json({ error: 'Error de base de datos: ' + error.message });
    if (!template) return res.status(404).json({ error: 'Plantilla no encontrada' });
    if (!template.published) return res.status(404).json({ error: 'Esta plantilla no está publicada aún' });

    await safeRpc('increment_views', { template_id: template.id });

    console.log(`✅ Encontrada: ${template.title}`);
    res.json(template);
  } catch (err) {
    res.status(500).json({ error: 'Error interno: ' + err.message });
  }
});

export default router;
