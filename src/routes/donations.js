import { Router } from 'express';
import { supabase } from '../lib/supabase.js';
import { optionalAuth } from '../middleware/auth.js';
import { authenticate } from '../middleware/auth.js';

const router = Router();

// POST /api/donations/record
router.post('/record', optionalAuth, async (req, res) => {
  try {
    const { amount, method, name, email, message, card_last4 } = req.body;

    if (!amount || !method) {
      return res.status(400).json({ error: 'Monto y método son requeridos' });
    }

    const { data, error } = await supabase
      .from('donations')
      .insert({
        user_id: req.user?.id || null,
        amount: parseFloat(amount),
        method,
        donor_name: name || 'Anónimo',
        donor_email: email || null,
        message: message || null,
        card_last4: card_last4 || null,
        status: 'pending',
      })
      .select()
      .single();

    if (error) throw error;

    res.status(201).json({ donation: data, message: '¡Donación registrada! Gracias por tu apoyo.' });
  } catch (err) {
    console.error('Donation error:', err);
    res.status(500).json({ error: 'Error al registrar donación' });
  }
});

// GET /api/donations/payment-info
router.get('/payment-info', (req, res) => {
  res.json({
    paypal: process.env.PAYPAL_EMAIL || 'codeninja5@paypal.com',
    yape: process.env.YAPE_NUMBER || '+51 999 999 999',
  });
});

// POST /api/donations/membership (kept for direct endpoint use)
router.post('/membership', authenticate, async (req, res) => {
  try {
    const { method } = req.body;
    const { data, error } = await supabase
      .from('membership_requests')
      .insert({ user_id: req.user.id, method, status: 'pending' })
      .select().single();
    if (error) throw error;
    res.status(201).json({ request: data, message: 'Solicitud de membresía enviada.' });
  } catch (err) {
    res.status(500).json({ error: 'Error al procesar solicitud de membresía' });
  }
});

export default router;
