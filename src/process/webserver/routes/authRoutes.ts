/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Express, Request, Response } from 'express';
import { AuthService } from '@process/webserver/auth/service/AuthService';
import { AuthMiddleware } from '@process/webserver/auth/middleware/AuthMiddleware';
import { UserRepository } from '@process/webserver/auth/repository/UserRepository';
import { AUTH_CONFIG, getCookieOptions } from '../config/constants';
import { TokenUtils } from '@process/webserver/auth/middleware/TokenMiddleware';
import { createAppError } from '../middleware/errorHandler';
import { authRateLimiter, authenticatedActionLimiter, apiRateLimiter } from '../middleware/security';
import { verifyQRTokenDirect } from '@process/bridge/webuiQR';

/**
 * QR login page HTML (static, no user input embedded)
 * JavaScript reads token directly from URL params to prevent XSS
 */
const QR_LOGIN_PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>QR Login · Wayland</title>
  <style>
    :root {
      --brand: #ff6b35;
      --brand-soft: rgba(255, 107, 53, 0.18);
      --bg-0: #0a0a0a;
      --bg-1: #161616;
      --border: #2a2a2a;
      --text-primary: #f5f5f5;
      --text-secondary: #a8a8a8;
      --success: #4ade80;
      --error: #f87171;
    }
    * { box-sizing: border-box; }
    html, body {
      margin: 0;
      padding: 0;
      min-height: 100vh;
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      color: var(--text-primary);
      background:
        radial-gradient(circle at 20% 10%, rgba(255, 107, 53, 0.10), transparent 55%),
        radial-gradient(circle at 80% 85%, rgba(255, 107, 53, 0.06), transparent 60%),
        var(--bg-0);
    }
    body { display: flex; justify-content: center; align-items: center; }
    .container {
      text-align: center;
      padding: 48px 40px;
      background: var(--bg-1);
      border: 1px solid var(--border);
      border-radius: 16px;
      box-shadow: 0 24px 60px rgba(0, 0, 0, 0.45);
      max-width: 420px;
      width: calc(100% - 48px);
    }
    .logo {
      width: 56px;
      height: 56px;
      margin: 0 auto 20px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 14px;
      background:
        radial-gradient(circle at 30% 30%, var(--brand-soft), transparent 70%),
        #141414;
      border: 1px solid var(--border);
    }
    .brand { font-size: 13px; letter-spacing: 0.18em; text-transform: uppercase; color: var(--text-secondary); margin-bottom: 8px; }
    h2 { font-size: 22px; font-weight: 600; margin: 0 0 12px; letter-spacing: -0.01em; }
    h2.success { color: var(--success); }
    h2.error { color: var(--error); }
    p { font-size: 14px; line-height: 1.55; color: var(--text-secondary); margin: 12px 0 0; }
    .loading { color: var(--brand); font-size: 16px; }
    .spinner {
      border: 3px solid rgba(255, 107, 53, 0.18);
      border-top-color: var(--brand);
      border-radius: 50%;
      width: 36px;
      height: 36px;
      animation: spin 0.9s linear infinite;
      margin: 24px auto 16px;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div class="container" id="content">
    <div class="logo">
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#ff6b35" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M20.341 6.484A10 10 0 0 1 10.266 21.85"/>
        <path d="M3.659 17.516A10 10 0 0 1 13.74 2.152"/>
        <circle cx="12" cy="12" r="3"/>
        <circle cx="19" cy="5" r="2"/>
        <circle cx="5" cy="19" r="2"/>
      </svg>
    </div>
    <div class="brand">Wayland</div>
    <div class="spinner"></div>
    <p class="loading">Verifying QR code…</p>
  </div>
  <script>
    (async function() {
      var container = document.getElementById('content');
      var SVG_NS = 'http://www.w3.org/2000/svg';
      function el(tag, attrs, ns) {
        var node = ns ? document.createElementNS(ns, tag) : document.createElement(tag);
        if (attrs) for (var k in attrs) node.setAttribute(k, attrs[k]);
        return node;
      }
      function buildLogoBlock() {
        var frag = document.createDocumentFragment();
        var box = el('div'); box.className = 'logo';
        var svg = el('svg', { width: '32', height: '32', viewBox: '0 0 24 24', fill: 'none', stroke: '#ff6b35', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' }, SVG_NS);
        var paths = [
          ['path', { d: 'M20.341 6.484A10 10 0 0 1 10.266 21.85' }],
          ['path', { d: 'M3.659 17.516A10 10 0 0 1 13.74 2.152' }],
          ['circle', { cx: '12', cy: '12', r: '3' }],
          ['circle', { cx: '19', cy: '5', r: '2' }],
          ['circle', { cx: '5', cy: '19', r: '2' }],
        ];
        for (var i = 0; i < paths.length; i++) svg.appendChild(el(paths[i][0], paths[i][1], SVG_NS));
        box.appendChild(svg);
        frag.appendChild(box);
        var brand = el('div'); brand.className = 'brand'; brand.textContent = 'Wayland';
        frag.appendChild(brand);
        return frag;
      }
      function render(kind, title, detail) {
        while (container.firstChild) container.removeChild(container.firstChild);
        container.appendChild(buildLogoBlock());
        var h2 = document.createElement('h2');
        h2.className = kind;
        h2.textContent = title;
        container.appendChild(h2);
        if (detail) {
          var p = document.createElement('p');
          p.textContent = detail;
          container.appendChild(p);
        }
      }
      var params = new URLSearchParams(window.location.search);
      var qrToken = params.get('token');
      if (!qrToken) {
        render('error', 'Invalid QR code', 'The QR code is invalid or missing.');
        return;
      }
      try {
        var response = await fetch('/api/auth/qr-login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ qrToken: qrToken }),
          credentials: 'include'
        });
        var data = await response.json();
        if (data.success) {
          render('success', 'Login successful', 'Redirecting…');
          setTimeout(function() { window.location.href = '/'; }, 900);
        } else {
          render('error', 'Login failed', data.error || 'QR code expired or invalid. Please scan a fresh one.');
        }
      } catch (e) {
        render('error', 'Network error', 'Could not reach the server. Please try again.');
      }
    })();
  </script>
</body>
</html>`;

/**
 * Register authentication routes
 */
export function registerAuthRoutes(app: Express): void {
  /**
   * Login endpoint
   * POST /login
   */
  // Login attempts are strictly rate limited to defend against brute force
  app.post('/login', authRateLimiter, AuthMiddleware.validateLoginInput, async (req: Request, res: Response) => {
    try {
      const { username, password } = req.body;

      // Get user from database
      const user = await UserRepository.findByUsername(username);
      if (!user) {
        // Use constant time verification to prevent timing attacks
        await AuthService.constantTimeVerifyMissingUser();
        res.status(401).json({
          success: false,
          message: 'Invalid username or password',
        });
        return;
      }

      // Verify password with constant time
      const isValidPassword = await AuthService.constantTimeVerify(password, user.password_hash, true);
      if (!isValidPassword) {
        res.status(401).json({
          success: false,
          message: 'Invalid username or password',
        });
        return;
      }

      // Generate JWT token
      const token = await AuthService.generateToken(user);

      // Update last login
      await UserRepository.updateLastLogin(user.id);

      // Set secure cookie (enable secure flag in remote mode)
      res.cookie(AUTH_CONFIG.COOKIE.NAME, token, {
        ...getCookieOptions(req),
        maxAge: AUTH_CONFIG.TOKEN.COOKIE_MAX_AGE,
      });

      res.json({
        success: true,
        message: 'Login successful',
        user: {
          id: user.id,
          username: user.username,
        },
        token,
      });
    } catch (error) {
      console.error('Login error:', error);
      res.status(500).json({ success: false, message: 'Internal server error' });
    }
  });

  /**
   * Logout endpoint
   * POST /logout
   */
  // Authenticated endpoints reuse shared limiter keyed by user/IP
  app.post(
    '/logout',
    apiRateLimiter,
    AuthMiddleware.authenticateToken,
    authenticatedActionLimiter,
    (req: Request, res: Response) => {
      // Blacklist current token
      const token = TokenUtils.extractFromRequest(req);
      if (token) {
        AuthService.blacklistToken(token);
      }

      res.clearCookie(AUTH_CONFIG.COOKIE.NAME);
      res.json({ success: true, message: 'Logged out successfully' });
    }
  );

  /**
   * Get authentication status
   * GET /api/auth/status
   */
  // Rate limit auth status endpoint to prevent enumeration
  app.get('/api/auth/status', apiRateLimiter, (_req: Request, res: Response) => {
    Promise.all([UserRepository.hasUsers(), UserRepository.countUsers()])
      .then(([hasUsers, userCount]) => {
        res.json({
          success: true,
          needsSetup: !hasUsers,
          userCount,
          isAuthenticated: false, // Will be determined by frontend based on token
        });
      })
      .catch((error) => {
        console.error('Auth status error:', error);
        res.status(500).json({
          success: false,
          error: 'Internal server error',
        });
      });
  });

  /**
   * Get current user (protected route)
   * GET /api/auth/user
   */
  // Add rate limiting for authenticated user info endpoint
  app.get(
    '/api/auth/user',
    apiRateLimiter,
    AuthMiddleware.authenticateToken,
    authenticatedActionLimiter,
    (req: Request, res: Response) => {
      res.json({
        success: true,
        user: req.user,
      });
    }
  );

  /**
   * Change password endpoint (protected route)
   * POST /api/auth/change-password
   */
  app.post(
    '/api/auth/change-password',
    apiRateLimiter,
    AuthMiddleware.authenticateToken,
    authenticatedActionLimiter,
    async (req: Request, res: Response) => {
      try {
        const { currentPassword, newPassword } = req.body;

        if (!currentPassword || !newPassword) {
          res.status(400).json({
            success: false,
            error: 'Current password and new password are required',
          });
          return;
        }

        // Validate new password strength
        const passwordValidation = AuthService.validatePasswordStrength(newPassword);
        if (!passwordValidation.isValid) {
          res.status(400).json({
            success: false,
            error: 'New password does not meet security requirements',
            details: passwordValidation.errors,
          });
          return;
        }

        // Get current user
        const user = await UserRepository.findById(req.user!.id);
        if (!user) {
          res.status(404).json({
            success: false,
            error: 'User not found',
          });
          return;
        }

        // Verify current password
        const isValidPassword = await AuthService.verifyPassword(currentPassword, user.password_hash);
        if (!isValidPassword) {
          res.status(401).json({
            success: false,
            error: 'Current password is incorrect',
          });
          return;
        }

        // Hash new password
        const newPasswordHash = await AuthService.hashPassword(newPassword);

        // Update password
        await UserRepository.updatePassword(user.id, newPasswordHash);
        await AuthService.invalidateAllTokens();

        res.json({
          success: true,
          message: 'Password changed successfully',
        });
      } catch (error) {
        console.error('Change password error:', error);
        res.status(500).json({
          success: false,
          error: 'Internal server error',
        });
      }
    }
  );

  /**
   * Token refresh endpoint
   * POST /api/auth/refresh
   */
  app.post('/api/auth/refresh', apiRateLimiter, authenticatedActionLimiter, (req: Request, res: Response) => {
    void (async () => {
      try {
        const bodyToken = typeof req.body?.token === 'string' ? req.body.token : null;
        const token = bodyToken ?? TokenUtils.extractFromRequest(req);

        if (!token) {
          res.status(400).json({
            success: false,
            error: 'Token is required',
          });
          return;
        }

        const newToken = await AuthService.refreshToken(token);
        if (!newToken) {
          res.status(401).json({
            success: false,
            error: 'Invalid or expired token',
          });
          return;
        }

        if (!bodyToken && typeof req.cookies?.[AUTH_CONFIG.COOKIE.NAME] === 'string') {
          res.cookie(AUTH_CONFIG.COOKIE.NAME, newToken, {
            ...getCookieOptions(req),
            maxAge: AUTH_CONFIG.TOKEN.COOKIE_MAX_AGE,
          });
        }

        res.json({
          success: true,
          token: newToken,
        });
      } catch (error) {
        console.error('Token refresh error:', error);
        res.status(500).json({
          success: false,
          error: 'Internal server error',
        });
      }
    })();
  });

  /**
   * Generate WebSocket token
   * GET /api/ws-token
   *
   * Note: WebSocket now reuses the main token, this endpoint returns the main token for backward compatibility
   */
  // Rate limit WebSocket token endpoint
  app.get('/api/ws-token', apiRateLimiter, authenticatedActionLimiter, async (req: Request, res: Response, next) => {
    try {
      const sessionToken = TokenUtils.extractFromRequest(req);

      if (!sessionToken) {
        return next(createAppError('Unauthorized: Invalid or missing session', 401, 'unauthorized'));
      }

      const decoded = await AuthService.verifyToken(sessionToken);
      if (!decoded) {
        return next(createAppError('Unauthorized: Invalid session token', 401, 'unauthorized'));
      }

      const user = await UserRepository.findById(decoded.userId);
      if (!user) {
        return next(createAppError('Unauthorized: User not found', 401, 'unauthorized'));
      }

      // Return the main token directly; no separate WebSocket token is generated
      res.json({
        success: true,
        wsToken: sessionToken, // reuse the main token
        expiresIn: AUTH_CONFIG.TOKEN.COOKIE_MAX_AGE, // use the main token's expiry
      });
    } catch (error) {
      next(error);
    }
  });

  /**
   * QR code login verification
   * POST /api/auth/qr-login
   */
  app.post('/api/auth/qr-login', authRateLimiter, async (req: Request, res: Response) => {
    try {
      const { qrToken } = req.body;

      if (!qrToken) {
        res.status(400).json({
          success: false,
          error: 'QR token is required',
        });
        return;
      }

      // Get client IP (for local network restriction verification)
      const clientIP = req.ip || req.socket.remoteAddress || '';

      // Verify QR token directly (no IPC)
      const result = await verifyQRTokenDirect(qrToken, clientIP);

      if (!result.success || !result.data) {
        res.status(401).json({
          success: false,
          error: result.msg || 'Invalid or expired QR token',
        });
        return;
      }

      // Set session cookie (enable secure flag in remote mode)
      res.cookie(AUTH_CONFIG.COOKIE.NAME, result.data.sessionToken, {
        ...getCookieOptions(req),
        maxAge: AUTH_CONFIG.TOKEN.COOKIE_MAX_AGE,
      });

      res.json({
        success: true,
        user: { username: result.data.username },
        token: result.data.sessionToken,
      });
    } catch (error) {
      console.error('QR login error:', error);
      res.status(500).json({
        success: false,
        error: 'Internal server error',
      });
    }
  });

  /**
   * QR code login page
   * GET /qr-login
   * Security: Return static HTML, JavaScript reads token from URL to prevent XSS
   */
  app.get('/qr-login', (_req: Request, res: Response) => {
    res.send(QR_LOGIN_PAGE_HTML);
  });
}

export default registerAuthRoutes;
