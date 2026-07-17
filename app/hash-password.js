const bcrypt = require('bcryptjs');
const password = process.argv[2];
if (!password) {
  console.error('Usage: node hash-password.js <your-password>');
  process.exit(1);
}
bcrypt.hash(password, 10).then((hash) => console.log(hash));
