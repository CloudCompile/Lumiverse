import { Hono } from "hono";
import { auth, CREATION_NONCE_HEADER } from "../auth";
import { getDb } from "../db/connection";
import { getClientIp } from "../utils/client-ip";
import { rateLimit } from "../middleware/rate-limit";
import { sendEmail } from "../services/email.service";

const app = new Hono();

// Reserved usernames to prevent impersonation
const RESERVED_USERNAMES = new Set(["admin", "operator", "system", "root", "owner", "administrator"]);

// Validation helpers
function validateUsername(username: string): { valid: boolean; error?: string } {
  if (!username || typeof username !== "string") {
    return { valid: false, error: "Username is required" };
  }
  if (username.length < 3) {
    return { valid: false, error: "Username must be at least 3 characters" };
  }
  if (username.length > 32) {
    return { valid: false, error: "Username must be at most 32 characters" };
  }
  if (!/^[a-zA-Z0-9_]+$/.test(username)) {
    return { valid: false, error: "Username can only contain alphanumeric characters and underscores" };
  }
  const normalized = username.toLowerCase();
  if (RESERVED_USERNAMES.has(normalized)) {
    return { valid: false, error: "This username is reserved" };
  }
  return { valid: true };
}

function validateEmail(email: string): { valid: boolean; error?: string } {
  if (!email || typeof email !== "string") {
    return { valid: false, error: "Email is required" };
  }
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return { valid: false, error: "Invalid email address" };
  }
  return { valid: true };
}

function validatePassword(password: string): { valid: boolean; error?: string } {
  if (!password || typeof password !== "string") {
    return { valid: false, error: "Password is required" };
  }
  if (password.length < 8) {
    return { valid: false, error: "Password must be at least 8 characters" };
  }
  if (password.length > 128) {
    return { valid: false, error: "Password must be at most 128 characters" };
  }
  return { valid: true };
}

function userExists(username: string, email: string): { exists: boolean; field?: string } {
  const userByUsername = getDb()
    .query('SELECT id FROM "user" WHERE LOWER(username) = LOWER(?)')
    .get(username) as { id: string } | null;

  if (userByUsername) {
    return { exists: true, field: "username" };
  }

  const userByEmail = getDb()
    .query('SELECT id FROM "user" WHERE LOWER(email) = LOWER(?)')
    .get(email) as { id: string } | null;

  if (userByEmail) {
    return { exists: true, field: "email" };
  }

  return { exists: false };
}

// Rate limiters
const signupLimiter = rateLimit({
  bucket: "signup",
  max: 2,
  windowMs: 24 * 60 * 60 * 1000, // 2 per 24 hours
  message: "Too many signup attempts. Please try again in 24 hours.",
});

const checkLimiter = rateLimit({
  bucket: "signup-check",
  max: 10,
  windowMs: 60 * 1000, // 10 per minute
  message: "Too many availability checks. Please slow down.",
});

// POST /public — Public signup endpoint
app.post("/public", signupLimiter, async (c) => {
  const body = await c.req.json();
  const clientIp = getClientIp(c);

  // Validate input
  const usernameValidation = validateUsername(body.username);
  if (!usernameValidation.valid) {
    return c.json({ error: usernameValidation.error }, 400);
  }

  const emailValidation = validateEmail(body.email);
  if (!emailValidation.valid) {
    return c.json({ error: emailValidation.error }, 400);
  }

  const passwordValidation = validatePassword(body.password);
  if (!passwordValidation.valid) {
    return c.json({ error: passwordValidation.error }, 400);
  }

  // Check uniqueness
  const existence = userExists(body.username, body.email);
  if (existence.exists) {
    const field = existence.field === "username" ? "Username" : "Email";
    return c.json({ error: `${field} already registered` }, 409);
  }

  try {
    // Create user without nonce (public signup path)
    const newUser = await auth.api.signUpEmail({
      body: {
        email: body.email,
        password: body.password,
        username: body.username,
        name: body.username,
      },
    });

    // Log signup to audit table
    getDb().run(
      "INSERT INTO signup_audit (email, ip_address, status, reason, created_at) VALUES (?, ?, ?, ?, ?)",
      [body.email, clientIp, "success", "public_signup", Math.floor(Date.now() / 1000)]
    );

    // Send welcome email (console logging for now)
    await sendEmail(
      body.email,
      "Welcome to Lumiverse",
      "welcome",
      { username: body.username }
    );

    return c.json(
      {
        user: newUser.user,
        message: "Account created successfully. You can now log in.",
      },
      201
    );
  } catch (err: any) {
    // Log error to audit table
    getDb().run(
      "INSERT INTO signup_audit (email, ip_address, status, reason, created_at) VALUES (?, ?, ?, ?, ?)",
      [body.email, clientIp, "error", err.message || "unknown_error", Math.floor(Date.now() / 1000)]
    );

    console.error("[Signup] Failed to create user:", err.message || err);
    return c.json({ error: "Failed to create account. Please try again." }, 400);
  }
});

// GET /check-username — Check username availability
app.get("/check-username", checkLimiter, async (c) => {
  const username = c.req.query("username");

  if (!username) {
    return c.json({ error: "Username is required" }, 400);
  }

  const validation = validateUsername(username);
  if (!validation.valid) {
    return c.json({ error: validation.error }, 400);
  }

  const user = getDb()
    .query('SELECT id FROM "user" WHERE LOWER(username) = LOWER(?)')
    .get(username) as { id: string } | null;

  return c.json({ available: !user });
});

// GET /check-email — Check email availability
app.get("/check-email", checkLimiter, async (c) => {
  const email = c.req.query("email");

  if (!email) {
    return c.json({ error: "Email is required" }, 400);
  }

  const validation = validateEmail(email);
  if (!validation.valid) {
    return c.json({ error: validation.error }, 400);
  }

  const user = getDb()
    .query('SELECT id FROM "user" WHERE LOWER(email) = LOWER(?)')
    .get(email) as { id: string } | null;

  return c.json({ available: !user });
});

export { app as signupRoutes };
