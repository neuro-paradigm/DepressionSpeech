const User = require('../models/User');
const { hashPassword, verifyPassword, signToken } = require('../utils/auth');

function authPayload(user) {
  return {
    token: signToken({ id: user._id.toString(), role: user.role }),
    user: {
      id: user._id,
      name: user.name,
      email: user.email,
      role: user.role,
      picture: user.picture,
    },
  };
}

async function signup(req, res, next) {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) return res.status(400).json({ message: 'Name, email, and password are required.' });
    if (typeof password !== 'string' || password.length < 8) {
      return res.status(400).json({ message: 'Password must be at least 8 characters long.' });
    }
    if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      return res.status(400).json({ message: 'Please provide a valid email address.' });
    }

    const existing = await User.findOne({ email });

    if (existing) {
      // If account was created via Google, allow linking by adding a password
      if (existing.provider === 'google' && !existing.passwordHash) {
        existing.passwordHash = hashPassword(password);
        existing.name = name || existing.name;
        existing.role = 'admin';
        await existing.save();
        return res.json(authPayload(existing));
      }
      return res.status(409).json({ message: 'An account already exists for this email.' });
    }

    const user = await User.create({
      name,
      email,
      role: 'admin',
      passwordHash: hashPassword(password),
      provider: 'local',
    });

    res.status(201).json(authPayload(user));
  } catch (error) {
    next(error);
  }
}

async function login(req, res, next) {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(401).json({ message: 'Invalid email or password.' });
    }
    // If user only has Google account, tell them
    if (user.provider === 'google' && !user.passwordHash) {
      return res.status(401).json({ message: 'This account uses Google sign-in. Please log in with Google or sign up to set a password.' });
    }
    if (!user.passwordHash || !verifyPassword(password, user.passwordHash)) {
      return res.status(401).json({ message: 'Invalid email or password.' });
    }
    if (user.role !== 'admin') {
      user.role = 'admin';
      await user.save();
    }
    res.json(authPayload(user));
  } catch (error) {
    next(error);
  }
}

/**
 * Verify a Google ID token (JWT) via Google's tokeninfo endpoint, which
 * validates the token signature server-side. Decoding the payload locally is
 * NOT sufficient: without signature verification anyone could forge a token
 * for any email address.
 */
async function verifyGoogleIdToken(idToken) {
  const response = await fetch(
    `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`,
    { signal: AbortSignal.timeout(10000) }
  );
  if (!response.ok) {
    throw new Error(`Google rejected the credential (HTTP ${response.status}).`);
  }
  return response.json();
}

async function googleLogin(req, res, next) {
  try {
    const { credential } = req.body;
    const clientId = (process.env.GOOGLE_CLIENT_ID || '').trim().replace(/^"|"$/g, '');
    if (!credential) return res.status(400).json({ message: 'Google credential is required.' });
    if (!clientId) return res.status(503).json({ message: 'GOOGLE_CLIENT_ID is not configured.' });

    let profile;
    try {
      profile = await verifyGoogleIdToken(credential);
    } catch (verifyError) {
      console.error('Google ID token verification error:', verifyError.message);
      return res.status(401).json({ message: 'Invalid Google credential.' });
    }

    // Defense in depth: re-check audience/expiry/issuer on the verified payload.
    if (profile.aud !== clientId) {
      console.error('Google aud mismatch:', { expected: clientId, got: profile.aud });
      return res.status(401).json({ message: 'Invalid Google credential: audience mismatch.' });
    }

    const nowSeconds = Math.floor(Date.now() / 1000);
    if (profile.exp && Number(profile.exp) < nowSeconds) {
      return res.status(401).json({ message: 'Google credential has expired.' });
    }

    const validIssuers = ['accounts.google.com', 'https://accounts.google.com'];
    if (profile.iss && !validIssuers.includes(profile.iss)) {
      return res.status(401).json({ message: 'Invalid Google credential: issuer mismatch.' });
    }

    if (!profile.email) {
      return res.status(401).json({ message: 'Google credential does not contain an email address.' });
    }

    const user = await User.findOneAndUpdate(
      { email: profile.email },
      {
        $setOnInsert: {
          email: profile.email,
          provider: 'google',
        },
        $set: {
          name: profile.name || profile.email,
          googleSub: profile.sub,
          picture: profile.picture,
          role: 'admin',
        },
      },
      { returnDocument: 'after', upsert: true, setDefaultsOnInsert: true }
    );

    res.json(authPayload(user));
  } catch (error) {
    next(error);
  }
}

async function me(req, res) {
  res.json({
    id: req.user._id,
    name: req.user.name,
    email: req.user.email,
    role: req.user.role,
    picture: req.user.picture,
  });
}

module.exports = {
  signup,
  login,
  googleLogin,
  me,
};
