#!/usr/bin/env node
/**
 * Password hash generator for RelayHall setup
 * Uses bcrypt to generate a hash that can be stored in .env
 */

// Try bcryptjs first (pure JS, works everywhere), fall back to bcrypt (native)
let bcrypt;
try { bcrypt = require('bcryptjs'); } catch { bcrypt = require('bcrypt'); }

const password = process.argv[2];

if (!password) {
  console.error('Usage: node hash-password.js <password>');
  process.exit(1);
}

bcrypt.hash(password, 10)
  .then(hash => {
    console.log(hash);
    process.exit(0);
  })
  .catch(err => {
    console.error('Error generating hash:', err.message);
    process.exit(1);
  });
