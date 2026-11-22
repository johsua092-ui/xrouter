package gateway

import (
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/johsua092-ui/xrouter/internal/auth"
	"github.com/johsua092-ui/xrouter/internal/database"
)

// Dashboard session routes. The cookie is the same `auth_token` HS256 JWT the Node
// dashboard issues, over the same secret, so a session created by one runtime is
// accepted by the other and a logout in either kills it for both.

// sessionCookieName is shared with the Node dashboard.
const sessionCookieName = "auth_token"

// authManager lazily builds the session manager from the configured data dir.
func (g *Gateway) authManager() *auth.Manager {
	if g.sessions == nil {
		g.sessions = auth.NewManager(g.cfg.DataDir)
	}
	return g.sessions
}

// sessionFromRequest returns the verified claims, or nil.
func (g *Gateway) sessionFromRequest(r *http.Request) auth.Claims {
	cookie, err := r.Cookie(sessionCookieName)
	if err != nil || cookie.Value == "" {
		return nil
	}
	claims, err := g.authManager().Verify(cookie.Value)
	if err != nil {
		return nil
	}
	return claims
}

// adminAuthorised is the single decision point for management access: a valid
// dashboard session, the operator token, or an unconfigured install reached over
// loopback.
func (g *Gateway) adminAuthorised(r *http.Request) bool {
	if g.sessionFromRequest(r) != nil {
		return true
	}
	if g.cfg.AdminToken != "" {
		supplied := strings.TrimSpace(r.Header.Get("X-Admin-Token"))
		if supplied == "" {
			supplied = strings.TrimSpace(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))
		}
		return supplied == g.cfg.AdminToken
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// handleAuthLogin serves POST /api/auth/login with either a password or an API key.
func (g *Gateway) handleAuthLogin(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		jsonError(w, http.StatusMethodNotAllowed, "method not allowed", nil)
		return
	}
	body, ok := decodeJSONBody(w, r)
	if !ok {
		return
	}

	settings, err := g.db.GetSettings()
	if err != nil && err != database.ErrNotFound {
		dbErrorToStatus(w, err)
		return
	}
	storedHash := asString(settings["password"])

	claims := auth.Claims{"role": "admin"}

	if suppliedKey := strings.TrimSpace(asString(body["apiKey"])); suppliedKey != "" {
		key, err := g.db.FindAPIKeyBySecret(suppliedKey)
		if err != nil || key == nil || !key.IsActive {
			jsonResponse(w, http.StatusUnauthorized, map[string]any{"error": "Invalid API key"})
			return
		}
		claims = auth.Claims{
			"role":    "apikey",
			"keyId":   key.ID,
			"keyName": key.Name,
			"permissions": map[string]any{
				"canUseChat":    true,
				"canManageKeys": false,
			},
		}
	} else {
		if err := g.authManager().CheckPassword(storedHash, asString(body["password"])); err != nil {
			jsonResponse(w, http.StatusUnauthorized, map[string]any{
				"error":     "Invalid password",
				"resetHint": "Forgot password? Reset to default via X Router CLI → Settings → Reset Password to Default.",
			})
			return
		}
	}

	token, err := g.authManager().Sign(claims)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "could not create session", err)
		return
	}

	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookieName,
		Value:    token,
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   requestIsHTTPS(r),
		MaxAge:   int(auth.SessionMaxAge / time.Second),
	})
	jsonResponse(w, http.StatusOK, map[string]any{"success": true})
}

// handleAuthLogout serves POST /api/auth/logout.
func (g *Gateway) handleAuthLogout(w http.ResponseWriter, r *http.Request) {
	if claims := g.sessionFromRequest(r); claims != nil {
		if err := g.authManager().Revoke(claims); err != nil {
			jsonError(w, http.StatusInternalServerError, "could not revoke session", err)
			return
		}
	}
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookieName,
		Value:    "",
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   requestIsHTTPS(r),
		MaxAge:   -1,
	})
	jsonResponse(w, http.StatusOK, map[string]any{"success": true})
}

// handleAuthStatus serves GET /api/auth/status.
func (g *Gateway) handleAuthStatus(w http.ResponseWriter, r *http.Request) {
	settings, err := g.db.GetSettings()
	if err != nil && err != database.ErrNotFound {
		dbErrorToStatus(w, err)
		return
	}

	claims := g.sessionFromRequest(r)
	requireLogin := true
	if flag, ok := settings["requireLogin"].(bool); ok {
		requireLogin = flag
	}
	authMode := asString(settings["authMode"])
	if authMode == "" {
		authMode = "password"
	}

	displayName := ""
	role := ""
	if claims != nil {
		role = asString(claims["role"])
		if role == "" {
			role = "admin"
		}
		switch role {
		case "apikey":
			displayName = asString(claims["keyName"])
			if displayName == "" {
				displayName = "API Key user"
			}
		default:
			displayName = "Password user"
		}
	}

	jsonResponse(w, http.StatusOK, map[string]any{
		"authenticated": claims != nil,
		"requireLogin":  requireLogin,
		"authMode":      authMode,
		"role":          role,
		"displayName":   displayName,
	})
}

// handleAuthResetPassword serves POST /api/auth/reset-password: restore the login
// to the default password. Requires an authorised caller because it is a
// deliberate lock-out escape hatch, not an anonymous reset.
func (g *Gateway) handleAuthResetPassword(w http.ResponseWriter, r *http.Request) {
	if !g.adminAuthorised(r) {
		jsonResponse(w, http.StatusUnauthorized, map[string]any{"error": "unauthorised"})
		return
	}
	hash, err := auth.HashPassword(auth.DefaultPassword)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "could not hash password", err)
		return
	}
	if _, err := g.db.SaveSettings(map[string]any{"password": hash}, "go-core", "password reset to default"); err != nil {
		dbErrorToStatus(w, err)
		return
	}
	jsonResponse(w, http.StatusOK, map[string]any{"success": true, "password": auth.DefaultPassword})
}

// handleAuthChangePassword serves POST /api/auth/change-password.
func (g *Gateway) handleAuthChangePassword(w http.ResponseWriter, r *http.Request) {
	if !g.adminAuthorised(r) {
		jsonResponse(w, http.StatusUnauthorized, map[string]any{"error": "unauthorised"})
		return
	}
	body, ok := decodeJSONBody(w, r)
	if !ok {
		return
	}
	newPassword := asString(body["newPassword"])
	if len(newPassword) < 4 {
		jsonError(w, http.StatusBadRequest, "Password must be at least 4 characters", nil)
		return
	}
	hash, err := auth.HashPassword(newPassword)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "could not hash password", err)
		return
	}
	if _, err := g.db.SaveSettings(map[string]any{"password": hash}, "go-core", "password changed"); err != nil {
		dbErrorToStatus(w, err)
		return
	}
	jsonResponse(w, http.StatusOK, map[string]any{"success": true})
}

func requestIsHTTPS(r *http.Request) bool {
	if r.TLS != nil {
		return true
	}
	return strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https") ||
		strings.EqualFold(r.Header.Get("X-Forwarded-Protocol"), "https")
}
