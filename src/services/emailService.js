const sgMail = require('@sendgrid/mail');
const qrcode = require('qrcode');
const puppeteer = require('puppeteer');

// Configure SendGrid
if (process.env.SENDGRID_API_KEY) {
    sgMail.setApiKey(process.env.SENDGRID_API_KEY);
}

const FROM_EMAIL = process.env.SENDGRID_FROM_EMAIL;
const REPLY_TO_EMAIL = process.env.SENDGRID_REPLY_TO_EMAIL || process.env.ADMIN_EMAIL;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
const FRONTEND_URL = (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '');

// Puppeteer Singleton Browser Manager
let browserInstance = null;
async function getBrowser() {
    if (!browserInstance || !browserInstance.isConnected()) {
        try {
            if (browserInstance) {
                await browserInstance.close().catch(() => {});
            }
            browserInstance = await puppeteer.launch({
                headless: 'new',
                args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
            });
            console.log('[BROWSER] Singleton browser instance launched.');
            
            browserInstance.on('disconnected', () => {
                console.log('[BROWSER] Browser disconnected.');
                browserInstance = null;
            });
        } catch (error) {
            console.error('[BROWSER_ERROR] Failed to launch browser:', error.message);
            throw error;
        }
    }
    return browserInstance;
}

/**
 * Helper to wrap a promise with a timeout
 */
function withTimeout(promise, ms, errorName) {
    const timeout = new Promise((_, reject) => {
        setTimeout(() => reject(new Error(`${errorName} timed out after ${ms}ms`)), ms);
    });
    return Promise.race([promise, timeout]);
}

/**
 * Generate QR Code as Base64 Data URL
 */
async function generateQRCode(payload, orderId = 'N/A') {
    try {
        const dataUrl = await withTimeout(qrcode.toDataURL(payload), 5000, 'QR_GENERATION');
        return dataUrl;
    } catch (error) {
        console.error(`[QR_ERROR] orderId=${orderId} error=${error.message}`);
        return null;
    }
}

/**
 * Generate a minimalist PDF ticket
 */
async function generateTicketPDF(eventData, attendeeData, orderData, qrCodes) {
    let page = null;
    try {
        const browser = await getBrowser();
        page = await browser.newPage();

        const ticketsHtml = qrCodes.map((qr, index) => `
            <div class="ticket" style="${index < qrCodes.length - 1 ? 'page-break-after: always;' : ''}">
                <div class="header">
                    <div class="label">Event Ticket - ${index + 1} of ${qrCodes.length}</div>
                    <div class="event-name">${eventData.title}</div>
                </div>
                <div class="details">
                    <div style="float: left; width: 50%;">
                        <p><span class="label">Attendee</span><br><strong>${attendeeData.name}</strong></p>
                        <p><span class="label">Order ID</span><br>${orderData.id}</p>
                    </div>
                    <div style="float: left; width: 50%;">
                        <p><span class="label">Amount Paid</span><br>${orderData.amount}</p>
                    </div>
                    <div style="clear: both;"></div>
                </div>
                <div class="qr-section">
                    <img class="qr-image" src="${qr}" />
                    <div class="label" style="margin-top: 10px;">Scan at Entry</div>
                </div>
                <div class="footer">
                    Powered by EventHubix • This ticket is valid for one entry only.<br>
                    For refunds, contact us at ${REPLY_TO_EMAIL}
                </div>
            </div>
        `).join('');

        const htmlContent = `
            <!DOCTYPE html>
            <html>
            <head>
                <style>
                    body { font-family: 'Helvetica', sans-serif; margin: 0; color: #333; }
                    .ticket { border: 2px solid #EEE; padding: 40px; max-width: 600px; margin: 40px auto; border-radius: 8px; }
                    .header { text-align: center; border-bottom: 2px solid #F5F5F5; padding-bottom: 20px; }
                    .event-name { font-size: 24px; font-weight: bold; margin: 10px 0; color: #1A1A1A; }
                    .details { margin: 20px 0; font-size: 14px; line-height: 1.6; }
                    .label { color: #888; text-transform: uppercase; font-size: 10px; font-weight: bold; letter-spacing: 1px; }
                    .qr-section { text-align: center; margin-top: 30px; }
                    .qr-image { width: 180px; height: 180px; border: 1px solid #EEE; padding: 10px; border-radius: 4px; }
                    .footer { text-align: center; font-size: 10px; color: #AAA; margin-top: 40px; border-top: 1px solid #F5F5F5; padding-top: 15px; }
                </style>
            </head>
            <body>
                ${ticketsHtml}
            </body>
            </html>
        `;

        await withTimeout(page.setContent(htmlContent), 5000, 'PDF_CONTENT_SET');
        const pdfBuffer = await withTimeout(page.pdf({ format: 'A4', printBackground: true }), 5000, 'PDF_GENERATION');
        return pdfBuffer;
    } catch (error) {
        console.error(`[PDF_ERROR] orderId=${orderData.id} error=${error.message}`);
        return null;
    } finally {
        if (page) await page.close().catch(() => {});
    }
}

/**
 * Base Layout Wrapper for consistency (Premium Redesign)
 */
function getEmailLayout(content, preheader = '') {
    return `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>EventHubix Notification</title>
            <style>
                @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800&display=swap');
                body { margin: 0; padding: 0; min-width: 100%; font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif !important; background-color: #F8FAFC; -webkit-font-smoothing: antialiased; }
                table { border-spacing: 0; }
                img { border: 0; }
                .wrapper { width: 100%; table-layout: fixed; background-color: #F8FAFC; padding-bottom: 40px; padding-top: 40px; }
                .main { background-color: #FFFFFF; margin: 0 auto; width: 100%; max-width: 600px; border-spacing: 0; border-radius: 24px; overflow: hidden; box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.05), 0 4px 6px -2px rgba(0, 0, 0, 0.02); }
                @media only screen and (max-width: 600px) {
                    .main { border-radius: 0 !important; }
                    .content { padding: 30px 20px !important; }
                }
            </style>
        </head>
        <body>
            <center class="wrapper">
                <div style="display: none; max-height: 0; overflow: hidden; font-size: 1px; color: #F8FAFC; line-height: 1px;">${preheader}</div>
                <table class="main" width="100%">
                    <!-- Header -->
                    <tr>
                        <td style="padding: 40px 0 35px; text-align: center; background: linear-gradient(135deg, #4F46E5 0%, #6366F1 100%);">
                            <h1 style="color: #FFFFFF; margin: 0; font-size: 26px; font-weight: 800; letter-spacing: -1px;">EventHubix</h1>
                        </td>
                    </tr>
                    <!-- Body -->
                    <tr>
                        <td class="content" style="padding: 50px 40px; background-color: #FFFFFF;">
                            ${content}
                        </td>
                    </tr>
                    <!-- Footer -->
                    <tr>
                        <td style="padding: 40px 40px 50px; text-align: center; background-color: #FBFCFE; border-top: 1px solid #F1F5F9;">
                            <p style="margin: 0; color: #94A3B8; font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em;">© 2026 <strong>EventHubix</strong></p>
                            <div style="margin-top: 20px; color: #64748B; font-size: 14px; line-height: 1.6;">
                                <p style="margin: 0;">Need any assistance? Connect with our <a href="mailto:${REPLY_TO_EMAIL}" style="color: #4F46E5; text-decoration: none; font-weight: 600;">Support Team</a></p>
                                <p style="margin: 15px 0 0; font-size: 11px; color: #cbd5e1; max-width: 400px; margin-left: auto; margin-right: auto;">
                                    This email was sent regarding your order. By using our platform, you agree to our 
                                    <a href="${FRONTEND_URL}/terms" style="color: #94a3b8; text-decoration: underline;">Terms</a> and 
                                    <a href="${FRONTEND_URL}/privacy" style="color: #94a3b8; text-decoration: underline;">Privacy Policy</a>.
                                </p>
                            </div>
                        </td>
                    </tr>
                </table>
            </center>
        </body>
        </html>
    `;
}

/**
 * Modern CTA Button helper
 */
function getCTAButton(text, url) {
    return `
        <div style="text-align: center; margin: 40px 0;">
            <!--[if mso]>
            <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${url}" style="height:55px;v-text-anchor:middle;width:220px;" arcsize="15%" stroke="f" fillcolor="#4F46E5">
                <w:anchorlock/>
                <center style="color:#ffffff;font-family:sans-serif;font-size:16px;font-weight:bold;">${text}</center>
            </v:roundrect>
            <![endif]-->
            <a href="${url}" style="background-color: #4F46E5; color: #FFFFFF; padding: 18px 36px; border-radius: 14px; text-decoration: none; font-weight: 700; display: inline-block; font-size: 16px; transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1); box-shadow: 0 10px 15px -3px rgba(79, 70, 229, 0.2), 0 4px 6px -2px rgba(79, 70, 229, 0.1);">
                ${text}
            </a>
        </div>
    `;
}

/**
 * Template: Ticket Confirmation (Buyer)
 */
function getTicketConfirmationTemplate({ attendeeName, eventTitle, eventDate, location, orderId, amount, ticketsCount, qrCodes }) {
    const formattedDate = (eventDate instanceof Date) 
        ? eventDate.toLocaleString('en-AU', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })
        : (eventDate || 'Coming Soon');

    const qrSections = (qrCodes || []).map((_, index) => `
        <div style="display: inline-block; width: 220px; vertical-align: top; margin: 15px; padding: 25px; background-color: #FFFFFF; border: 1.5px solid #F1F5F9; border-radius: 20px; text-align: center;">
            <img src="cid:ticket_qr_${index}" width="160" height="160" style="display: block; margin: 0 auto; border-radius: 12px; border: 1px solid #F1F5F9; padding: 8px; background-color: white;" alt="Ticket QR Code ${index + 1}" />
            <p style="margin: 15px 0 0; color: #64748B; font-size: 10px; text-transform: uppercase; font-weight: 800; letter-spacing: 0.1em;">Pass ${index + 1} of ${ticketsCount}</p>
        </div>
    `).join('');

    const content = `
        <div style="text-align: center; margin-bottom: 35px;">
            <div style="display: inline-block; padding: 12px 24px; background-color: #F0F9FF; border-radius: 100px; margin-bottom: 20px;">
                <span style="color: #0284C7; font-size: 12px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.15em;">Booking Confirmed</span>
            </div>
            <h2 style="margin: 0; color: #0F172A; font-size: 32px; font-weight: 800; letter-spacing: -1px; line-height: 1.1;">You're going to <br/><span style="color: #4F46E5;">${eventTitle}</span></h2>
            <p style="margin: 15px 0 0; color: #64748B; font-size: 17px; line-height: 1.6;">Hi ${attendeeName}, we've secured your spots! Your digital passes are ready below.</p>
        </div>
        
        <div style="background-color: #FFFFFF; border: 1.5px solid #F1F5F9; border-radius: 28px; padding: 35px; margin-bottom: 35px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.02);">
            <table border="0" cellpadding="0" cellspacing="0" width="100%">
                <tr>
                    <td style="padding-bottom: 25px; border-bottom: 1.5px dashed #F1F5F9;">
                        <p style="margin: 0 0 5px; color: #94A3B8; font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.1em;">Event Details</p>
                        <p style="margin: 0; font-size: 18px; color: #1E293B; font-weight: 700; line-height: 1.4;">${eventTitle}</p>
                        <p style="margin: 8px 0 0; font-size: 15px; color: #64748B;">📅 ${formattedDate}</p>
                        <p style="margin: 4px 0 0; font-size: 15px; color: #64748B;">📍 ${location || 'Venue TBD'}</p>
                    </td>
                </tr>
                <tr>
                    <td style="padding-top: 25px;">
                        <table border="0" cellpadding="0" cellspacing="0" width="100%">
                            <tr>
                                <td style="width: 50%; vertical-align: top; padding-right: 15px;">
                                    <p style="margin: 0 0 4px; color: #94A3B8; font-size: 10px; font-weight: 800; text-transform: uppercase;">Order ID</p>
                                    <p style="margin: 0; font-size: 14px; color: #1E293B; font-weight: 700; font-family: 'Courier New', monospace;">${orderId}</p>
                                </td>
                                <td style="width: 50%; vertical-align: top; text-align: right;">
                                    <p style="margin: 0 0 4px; color: #94A3B8; font-size: 10px; font-weight: 800; text-transform: uppercase;">Tickets</p>
                                    <p style="margin: 0; font-size: 14px; color: #1E293B; font-weight: 700;">${ticketsCount} Admit(s)</p>
                                </td>
                            </tr>
                            <tr>
                                <td colspan="2" style="padding-top: 20px;">
                                    <div style="background-color: #FAFAFB; padding: 15px 20px; border-radius: 12px; display: flex; justify-content: space-between; align-items: center;">
                                        <span style="font-size: 13px; color: #475569; font-weight: 600;">Paid Total</span>
                                        <span style="font-size: 20px; color: #4F46E5; font-weight: 800; float: right;">${amount}</span>
                                        <div style="clear: both;"></div>
                                    </div>
                                </td>
                            </tr>
                        </table>
                    </td>
                </tr>
            </table>
        </div>

        ${qrCodes && qrCodes.length > 0 ? `
        <div style="text-align: center; padding: 20px; background-color: #F8FAFC; border-radius: 28px; margin: 35px 0; border: 2px dashed #E2E8F0;">
            ${qrSections}
            <p style="margin: 10px 0 0; color: #94A3B8; font-size: 13px; font-weight: 500;">A consolidated PDF with all tickets is attached to this email.</p>
        </div>
        ` : ''}

        ${getCTAButton('View My Tickets', `${FRONTEND_URL}/order-tickets`)}
        
        <p style="text-align: center; color: #94A3B8; font-size: 13px; margin-top: 20px;">
            Need a refund? Check out our <a href="${FRONTEND_URL}/terms" style="color: #4F46E5; text-decoration: none;">refund policy</a> or reply to this email.
        </p>
    `;
    return getEmailLayout(content, `You're going to ${eventTitle}! Checkout your tickets.`);
}

/**
 * Template: Organizer Notification (Sale)
 */
function getOrganizerNotificationTemplate({ organizerName, eventTitle, quantity, amount, orderId, buyerName, buyerEmail }) {
    const content = `
        <div style="text-align: center; margin-bottom: 35px;">
            <div style="display: inline-block; padding: 12px 24px; background-color: #ECFDF5; border-radius: 100px; margin-bottom: 20px;">
                <span style="color: #059669; font-size: 13px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.15em;">Transaction Successful</span>
            </div>
            <h2 style="margin: 0; color: #0F172A; font-size: 32px; font-weight: 800; letter-spacing: -1px; line-height: 1.1;">🎉 Ticket Sold!</h2>
            <p style="margin: 15px 0 0; color: #64748B; font-size: 16px;">Great news! You have a new registration for your event.</p>
        </div>

        <div style="background-color: #F8FAFC; border: 1.5px solid #F1F5F9; border-radius: 28px; padding: 35px; margin-bottom: 35px;">
            <p style="margin: 0 0 5px; color: #94A3B8; font-size: 10px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.1em;">Event Project</p>
            <p style="margin: 0; font-size: 18px; color: #1E293B; font-weight: 700; line-height: 1.4;">${eventTitle}</p>
            
            <div style="margin-top: 30px; padding: 25px; background-color: #FFFFFF; border-radius: 20px; border: 1px solid #E2E8F0; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05);">
                <p style="margin: 0 0 5px; color: #94A3B8; font-size: 10px; font-weight: 800; text-transform: uppercase; text-align: center;">Total Revenue</p>
                <h3 style="margin: 0; font-size: 36px; color: #4F46E5; font-weight: 800; text-align: center; letter-spacing: -1px;">${amount}</h3>
                <p style="margin: 5px 0 0; color: #64748B; font-size: 13px; text-align: center;">for <strong>${quantity}</strong> ticket(s)</p>
            </div>

            <div style="margin-top: 35px; border-top: 1.5px dashed #E2E8F0; pt-30px;">
                <table border="0" cellpadding="0" cellspacing="0" width="100%" style="margin-top: 25px;">
                    <tr>
                        <td style="padding-bottom: 15px;">
                            <p style="margin: 0 0 4px; color: #94A3B8; font-size: 10px; font-weight: 800; text-transform: uppercase;">Buyer Details</p>
                            <p style="margin: 0; font-size: 15px; color: #1E293B; font-weight: 700;">${buyerName}</p>
                            <p style="margin: 2px 0 0; font-size: 13px; color: #64748B;">${buyerEmail}</p>
                        </td>
                    </tr>
                    <tr>
                        <td style="padding-top: 15px;">
                            <p style="margin: 0 0 4px; color: #94A3B8; font-size: 10px; font-weight: 800; text-transform: uppercase;">Reference ID</p>
                            <p style="margin: 0; font-size: 14px; color: #1E293B; font-weight: 700; font-family: 'Courier New', monospace;">${orderId}</p>
                        </td>
                    </tr>
                </table>
            </div>
        </div>

        ${getCTAButton('View Analytics Dashboard', `${FRONTEND_URL}/organiser/dashboard`)}
        
        <p style="text-align: center; color: #94A3B8; font-size: 13px; margin-top: 20px;">
            This notification was sent by EventHubix Platform. <br/>You can manage your notification preferences in your dashboard settings.
        </p>
    `;
    return getEmailLayout(content, `You just sold ${quantity} tickets for ${eventTitle}!`);
}

/**
 * Template: Admin Notification (New Organizer)
 */
function getAdminNotificationTemplate({ organizerName, organizerEmail, timestamp }) {
    const content = `
        <div style="text-align: center; margin-bottom: 35px;">
            <div style="display: inline-block; padding: 12px 24px; background-color: #FEF2F2; border-radius: 100px; margin-bottom: 20px; border: 1px solid #FEE2E2;">
                <span style="color: #EF4444; font-size: 13px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.15em;">Pending Approval</span>
            </div>
            <h2 style="margin: 0; color: #0F172A; font-size: 28px; font-weight: 800; letter-spacing: -1px; line-height: 1.1;">🆕 New Organiser Registration</h2>
            <p style="margin: 15px 0 0; color: #64748B; font-size: 16px;">An account is awaiting your review and activation.</p>
        </div>

        <div style="background-color: #FFFFFF; border: 1.5px solid #F1F5F9; border-radius: 28px; padding: 35px; margin-bottom: 35px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.02);">
            <p style="margin: 0 0 25px; color: #94A3B8; font-size: 11px; font-weight: 800; text-transform: uppercase; border-bottom: 1px solid #F1F5F9; padding-bottom: 15px;">Registrant Profile</p>
            <table border="0" cellpadding="0" cellspacing="0" width="100%">
                <tr>
                    <td style="padding-bottom: 12px;">
                        <p style="margin: 0; color: #64748B; font-size: 13px; font-weight: 600;">Full Name</p>
                        <p style="margin: 4px 0 0; color: #0F172A; font-size: 16px; font-weight: 700;">${organizerName}</p>
                    </td>
                </tr>
                <tr>
                    <td style="padding-bottom: 12px; padding-top: 12px;">
                        <p style="margin: 0; color: #64748B; font-size: 13px; font-weight: 600;">Email Address</p>
                        <p style="margin: 4px 0 0; color: #4F46E5; font-size: 16px; font-weight: 700;">${organizerEmail}</p>
                    </td>
                </tr>
                <tr>
                    <td style="padding-top: 12px;">
                        <p style="margin: 0; color: #64748B; font-size: 13px; font-weight: 600;">Submitted At</p>
                        <p style="margin: 4px 0 0; color: #0F172A; font-size: 16px; font-weight: 700;">${timestamp}</p>
                    </td>
                </tr>
            </table>
        </div>

        ${getCTAButton('Review & Approve Submission', `${FRONTEND_URL}/admin/organiser-requests`)}
        
        <p style="text-align: center; color: #94A3B8; font-size: 12px; margin-top: 30px; letter-spacing: 0.05em; text-transform: uppercase;">
            Admin Governance • EventHubix Internal Notification
        </p>
    `;
    return getEmailLayout(content, `New organizer registration: ${organizerName}`);
}

/**
 * Template: Newsletter Welcome
 */
function getNewsletterWelcomeTemplate(email) {
    const content = `
        <h2 style="margin: 0 0 15px; color: #111827; font-size: 24px; text-align: center;">Welcome to the Loop! 🚀</h2>
        <p style="margin: 0 0 25px; color: #4B5563; font-size: 16px; text-align: center; line-height: 1.6;">
            Thanks for subscribing to the <strong>EventHubix</strong> newsletter. You're now officially in the inner circle!
        </p>
        
        <div style="background-color: #F9FAFB; border: 1px solid #E5E7EB; border-radius: 12px; padding: 25px; margin-bottom: 30px;">
            <p style="margin: 0; color: #4B5563; font-size: 15px; line-height: 1.6;">
                Get ready for:
                <ul style="margin: 15px 0 0; padding-left: 20px; color: #4B5563;">
                    <li style="margin-bottom: 8px;">Exclusive event marketing tips</li>
                    <li style="margin-bottom: 8px;">Early access to new features</li>
                    <li style="margin-bottom: 8px;">Industry news and trends</li>
                </ul>
            </p>
        </div>

        <p style="margin: 0 0 20px; color: #6B7280; font-size: 14px; text-align: center;">
            You are receiving this because you subscribed at <span style="color: #4F46E5;">${FRONTEND_URL.replace(/https?:\/\//, '')}</span>
        </p>

        ${getCTAButton('Explore Events', `${FRONTEND_URL}/events`)}
    `;
    return getEmailLayout(content, "You're now subscribed to EventHubix!");
}

/**
 * Retry wrapper for SendGrid API calls
 */
async function sendWithRetry(sendFn, retries = 3, logType = 'unknown') {
    try {
        return await sendFn();
    } catch (err) {
        if (retries === 0) throw err;
        console.warn(`[EMAIL_RETRY] type=${logType} attempts_left=${retries} error=${err.message}`);
        await new Promise(resolve => setTimeout(resolve, 1000));
        return sendWithRetry(sendFn, retries - 1, logType);
    }
}

/**
 * Generic internal function to send emails safely.
 */
async function sendEmailRaw(msg, logType = 'unknown', orderId = 'N/A') {
    if (!process.env.SENDGRID_API_KEY || !FROM_EMAIL) {
        console.warn(`[EMAIL_SKIPPED] Missing SendGrid configuration. type=${logType} to=${msg.to}`);
        return;
    }

    try {
        msg.from = FROM_EMAIL;
        msg.replyTo = REPLY_TO_EMAIL;

        console.log(`[EMAIL_DEBUG] type=${logType} to=${msg.to} orderId=${orderId}`);
        const response = await sendWithRetry(() => sgMail.send(msg), 3, logType);
        console.log(`[EMAIL_SUCCESS] status=${response[0].statusCode} to=${msg.to} type=${logType}`);
    } catch (error) {
        console.error(`[EMAIL_ERROR] to=${msg.to} type=${logType} message=${error.message}`);
        if (error.response) {
            console.error(JSON.stringify(error.response.body));
        }
    }
}

/**
 * Send ticket confirmation to the attendee.
 */
async function sendTicketConfirmation(attendeeData, orderData, tickets) {
    let qrCodes = [];
    let pdfBuffer = null;

    try {
        // Generate QR codes for ALL tickets in parallel
        qrCodes = await Promise.all(
            tickets.map(t => generateQRCode(t.qrPayload, orderData.id))
        );

        // Filter out any failed generations (nulls)
        const validQrs = qrCodes.filter(q => q !== null);

        if (validQrs.length > 0) {
            // Pass all valid QR codes to generate a consolidated PDF
            pdfBuffer = await generateTicketPDF({ title: orderData.eventTitle }, attendeeData, orderData, validQrs);
        }
    } catch (err) {
        console.error(`[CONFIRMATION_ERROR] orderId=${orderData.id} error=${err.message}`);
    }

    const htmlTemplate = getTicketConfirmationTemplate({
        attendeeName: attendeeData.name,
        eventTitle: orderData.eventTitle,
        eventDate: orderData.eventDate,
        location: orderData.location,
        orderId: orderData.id,
        amount: orderData.amount,
        ticketsCount: tickets.length,
        qrCodes: qrCodes
    });

    let attachments = [];
    
    // Add all QR codes as inline attachments
    qrCodes.forEach((qr, index) => {
        if (qr) {
            const base64Data = qr.split(',')[1];
            attachments.push({
                content: base64Data,
                filename: `qr-${index}.png`,
                type: 'image/png',
                disposition: 'inline',
                content_id: `ticket_qr_${index}`
            });
        }
    });

    if (pdfBuffer) {
        try {
            const base64Content = Buffer.from(pdfBuffer).toString('base64');
            attachments.push({
                content: base64Content,
                filename: `tickets-${orderData.id}.pdf`,
                type: 'application/pdf',
                disposition: 'attachment'
            });
            console.log(`[EMAIL_DEBUG] type=attachment_ready orderId=${orderData.id} tickets=${tickets.length}`);
        } catch (encodingError) {
            console.error(`[EMAIL_ERROR] type=encoding_failed orderId=${orderData.id} error=${encodingError.message}`);
        }
    }

    const msg = {
        to: attendeeData.email,
        subject: `Your Tickets for ${orderData.eventTitle} - ${orderData.id}`,
        text: `Hi ${attendeeName}, your purchase for ${orderData.eventTitle} was successful! You have ${tickets.length} tickets. Order ID: ${orderData.id}.`,
        html: htmlTemplate,
        attachments: attachments
    };
 
    await sendEmailRaw(msg, 'ticket_confirmation', orderData.id);
}

/**
 * Notify organizer about a sale.
 */
async function sendOrganizerSaleNotification(organizerEmail, eventTitle, quantity, amount, orderId, buyerName, buyerEmail) {
    if (!organizerEmail) {
        console.warn(`[EMAIL_SKIPPED] type=organizer_ticket_sold reason=missing_email`);
        return;
    }

    const htmlTemplate = getOrganizerNotificationTemplate({
        eventTitle,
        quantity,
        amount,
        orderId,
        buyerName,
        buyerEmail
    });

    const msg = {
        to: organizerEmail,
        subject: `🎉 Ticket Sold! - ${eventTitle}`,
        text: `Great news! You just sold ${quantity} ticket(s) for your event: ${eventTitle}. Amount: ${amount}. Buyer: ${buyerName} (${buyerEmail})`,
        html: htmlTemplate,
    };
    await sendEmailRaw(msg, 'organizer_ticket_sold', orderId);
}

/**
 * Notify admin about a new organizer registration.
 */
async function sendAdminNewOrganizerAlert(organizerData) {
    if (!ADMIN_EMAIL) {
        console.warn(`[EMAIL_SKIPPED] type=admin_new_organizer reason=missing_admin_email`);
        return;
    }

    const timestamp = new Date().toLocaleString("en-AU", {
        dateStyle: "medium",
        timeStyle: "short"
    });

    const htmlTemplate = getAdminNotificationTemplate({
        organizerName: organizerData.name,
        organizerEmail: organizerData.email,
        timestamp
    });

    const msg = {
        to: ADMIN_EMAIL,
        subject: `🆕 New Organizer: ${organizerData.name}`,
        text: `A new organizer has registered: ${organizerData.name} (${organizerData.email}). Time: ${timestamp}`,
        html: htmlTemplate,
    };
    await sendEmailRaw(msg, 'admin_new_organizer');
}

/**
 * Send newsletter welcome email.
 */
async function sendNewsletterWelcome(email) {
    const htmlTemplate = getNewsletterWelcomeTemplate(email);
    const msg = {
        to: email,
        subject: `Welcome to EventHubix! 🚀`,
        text: `Thanks for subscribing to the EventHubix newsletter! We'll keep you updated with the latest event tips and news.`,
        html: htmlTemplate,
    };
    await sendEmailRaw(msg, 'newsletter_welcome');
}

/**
 * Orchestrator for purchase-related emails (fire-and-forget).
 */
function processPurchaseEmails({ attendeeEmail, attendeeName, orderId, totalAmount, eventTitle, eventDate, location, organizerEmail, tickets }) {
    // FIRE-AND-FORGET to avoid blocking the main thread
    setImmediate(async () => {
        try {
            await Promise.allSettled([
                sendTicketConfirmation(
                    { name: attendeeName, email: attendeeEmail }, 
                    { id: orderId, amount: totalAmount, eventTitle, eventDate, location }, 
                    tickets
                ),
                sendOrganizerSaleNotification(organizerEmail, eventTitle, tickets.length, totalAmount, orderId, attendeeName, attendeeEmail)
            ]);
        } catch (err) {
            console.error('[EMAIL_ORCHESTRATOR_ERROR] Critical failure in email batch:', err.message);
        }
    });
}

module.exports = {
    sendTicketConfirmation,
    sendOrganizerSaleNotification,
    sendAdminNewOrganizerAlert,
    sendNewsletterWelcome,
    processPurchaseEmails
};
