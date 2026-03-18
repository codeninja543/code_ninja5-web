import jwt from 'jsonwebtoken';
import { supabase } from '../lib/supabase.js';

export const authenticate = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // ── Siempre consultar el role real desde Supabase ──────────────────────
    // Así aunque cambiaste el role en Supabase, el backend lo detecta correctamente
    const { data: dbUser } = await supabase
      .from('users')
      .select('id, username, email, role')
      .eq('id', decoded.id)
      .maybeSingle();

    if (dbUser) {
      req.user = { ...decoded, role: dbUser.role };
    } else {
      req.user = decoded;
    }

    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
};

export const optionalAuth = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return next();
  }
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Consultar role real desde Supabase
    const { data: dbUser } = await supabase
      .from('users')
      .select('id, username, email, role')
      .eq('id', decoded.id)
      .maybeSingle();

    req.user = dbUser ? { ...decoded, role: dbUser.role } : decoded;
  } catch {
    // ignorar token inválido en rutas opcionales
  }
  next();
};
