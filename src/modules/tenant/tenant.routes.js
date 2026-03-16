const express = require('express');
const crypto = require('crypto');
const prisma = require('../../config/db');
const { requireAuth, requireRole } = require('../../middlewares/authMiddleware');

const router = express.Router();

/**
 * @route POST /api/tickets/purchase
 * @desc  Handle ticket purchase
 */
router.post('/purchase', async (req, res) => {
    const { eventId, quantity, attendeeName, attendeeEmail, promoCode } = req.body;

    if (!eventId || !quantity || !attendeeName || !attendeeEmail) {
        return res.status(400).json({ error: 'Missing required purchase details' });
    }

    try {
        const eventIdInt = parseInt(eventId);

        // Transaction to ensure atomicity
        const result = await prisma.$transaction(async (tx) => {
            const event = await tx.event.findUnique({
                where: { id: eventIdInt }
            });

            if (!event) throw new Error('Event not found');
            if (event.status !== 'APPROVED') throw new Error('Event is not open for sales');
            if (event.ticketsSold + quantity > event.totalTickets) throw new Error('Not enough tickets available');

            let discountAmount = 0;
            const subtotal = event.ticketPrice * quantity;

            // 1. Validate Promo Code if provided
            if (promoCode) {
                const promo = await tx.promocode.findUnique({
                    where: {
                        eventId_code: {
                            eventId: eventIdInt,
                            code: promoCode.toUpperCase()
                        }
                    }
                });

                if (!promo) throw new Error('Invalid promo code');

                // Expiry Check
                if (promo.expiresAt && new Date(promo.expiresAt) < new Date()) {
                    throw new Error('Promo code has expired');
                }

                // Usage Check
                if (promo.maxUsage > 0 && promo.currentUsage >= promo.maxUsage) {
                    throw new Error('Promo code usage limit reached');
                }

                // Calculate Discount
                if (promo.discountType === 'PERCENTAGE') {
                    discountAmount = (subtotal * promo.discountValue) / 100;
                } else {
                    discountAmount = promo.discountValue;
                }

                // Increment Usage
                await tx.promocode.update({
                    where: { id: promo.id },
                    data: { currentUsage: { increment: 1 } }
                });
            }

            // 2. Update event ticketsSold
            await tx.event.update({
                where: { id: eventIdInt },
                data: { ticketsSold: { increment: quantity } }
            });

            const tickets = [];
            // 3. Generate tickets
            for (let i = 0; i < quantity; i++) {
                const secureToken = crypto.randomBytes(8).toString('hex');
                const ticket = await tx.ticket.create({
                    data: {
                        eventId: eventIdInt,
                        buyerName: attendeeName,
                        buyerEmail: attendeeEmail,
                        // Store a dynamic verification payload that matches the URL format
                        qrPayload: `/verify/${secureToken}`, 
                        status: 'UNUSED'
                    }
                });
                tickets.push(ticket);
            }

            const isFree = event.ticketPrice === 0;
            const isBuyerCovering = event.serviceFeeType === 'BUYER';
            const feeRate = event.serviceFeeRate || 0.03;
            
            const fee = (isFree || !isBuyerCovering) ? 0 : parseFloat((subtotal * feeRate).toFixed(2));
            const finalTotal = subtotal + fee - discountAmount;

            return { tickets, totalAmount: finalTotal, discountApplied: discountAmount > 0 };
        });

        res.status(201).json({
            message: 'Purchase successful',
            orderId: `ORD-${Date.now()}`,
            tickets: result.tickets,
            totalAmount: result.totalAmount.toFixed(2),
            discountApplied: result.discountApplied
        });

    } catch (error) {
        console.error('Purchase transaction failed:', error);
        res.status(400).json({ error: error.message });
    }
});

/**
 * @route POST /api/tickets/validate
 * @desc  Validate a ticket QR payload (Used by scanner)
 */
router.post('/validate', requireAuth, requireRole(['ADMIN', 'ORGANIZER']), async (req, res) => {
    const { qrPayload } = req.body;

    if (!qrPayload) {
        return res.status(400).json({ error: 'QR Payload required' });
    }

    try {
        // Try direct lookup first
        let ticket = await prisma.ticket.findUnique({
            where: { qrPayload },
            include: { event: true }
        });

        // Smart Fallback: If it's a URL, extract the payload part
        if (!ticket && qrPayload.includes('/verify/')) {
            const parts = qrPayload.split('/verify/');
            const extractedPayload = '/verify/' + parts[parts.length - 1];
            
            ticket = await prisma.ticket.findUnique({
                where: { qrPayload: extractedPayload },
                include: { event: true }
            });
            
            // Extreme Fallback: If still not found, check if it's just the ID at the end
            if (!ticket) {
                const idMatch = qrPayload.match(/\/(\d+)$/);
                if (idMatch) {
                    ticket = await prisma.ticket.findUnique({
                        where: { id: parseInt(idMatch[1]) },
                        include: { event: true }
                    });
                }
            }
        }

        if (!ticket) {
            return res.status(400).json({ error: 'Invalid Ticket: No matching record found.' });
        }

        if (ticket.status === 'USED') {
            return res.status(400).json({ 
                error: 'Ticket already used',
                ticket: {
                    id: ticket.id,
                    buyerName: ticket.buyerName,
                    buyerEmail: ticket.buyerEmail,
                    eventTitle: ticket.event.title,
                    scannedAt: ticket.scannedAt
                }
            });
        }

        // Optional: Check if the logged in user has permission for THIS specific event
        if (req.user.role === 'ORGANIZER' && ticket.event.organizerId !== req.user.id) {
            return res.status(403).json({ error: 'Access denied: You are not the organizer of this event' });
        }

        // Mark as used
        const updatedTicket = await prisma.ticket.update({
            where: { id: ticket.id },
            data: {
                status: 'USED',
                scannedAt: new Date()
            }
        });

        res.json({
            status: 'valid',
            message: 'Ticket successfully verified. Enjoy the event!',
            ticket: {
                id: updatedTicket.id,
                buyerName: updatedTicket.buyerName,
                buyerEmail: updatedTicket.buyerEmail,
                eventTitle: ticket.event.title
            }
        });
    } catch (error) {
        console.error('Validation error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
