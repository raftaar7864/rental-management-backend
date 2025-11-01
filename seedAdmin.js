require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const User = require('./models/User');

async function run(){
  await mongoose.connect(process.env.MONGO_URI);
  const email = 'admin@rental.local';
  const exists = await User.findOne({ email });
  if(exists){
    console.log('Admin exists:', exists.email);
    process.exit(0);
  }
  const password = await bcrypt.hash('Admin@1234', 12);
  const user = await User.create({ name: 'Super Admin', email, password, role: 'admin' });
  console.log('Created admin -> email:', email, 'password: Admin@1234', 'id:', user._id);
  process.exit(0);
}

run().catch(err => { console.error(err); process.exit(1); });
