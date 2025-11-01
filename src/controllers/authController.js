// backend/src/controllers/authController.js
const asyncHandler = require('express-async-handler');
const User = require('../models/User');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'supersecret';

// @desc    Login user (admin or manager)
// @route   POST /api/auth/login
// @access  Public
exports.login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  const user = await User.findOne({ email }).populate('building');

  if (!user) return res.status(401).json({ message: 'Invalid credentials' });

  const match = await bcrypt.compare(password, user.password);
  if (!match) return res.status(401).json({ message: 'Invalid credentials' });

  const token = jwt.sign({ id: user._id }, JWT_SECRET, { expiresIn: '1d' });

  res.json({
    token,
    user: { _id: user._id, name: user.name, email: user.email, role: user.role, building: user.building }
  });
});

// @desc    Register new manager (admin only)
// @route   POST /api/auth/register
// @access  Admin
// backend/src/controllers/authController.js (only the register part changed)
exports.register = asyncHandler(async (req, res) => {
  const { name, email, password, role, building } = req.body;

  if (!name || !email || !password || !role)
    return res.status(400).json({ message: 'Missing required fields' });

  const existing = await User.findOne({ email });
  if (existing) return res.status(400).json({ message: 'Email already exists' });

  const hashed = await bcrypt.hash(password, 10);
  const newUser = await User.create({ name, email, password: hashed, role, building });

  // If a building id was provided and the role is manager, set building.manager = newUser._id
  if (role.toString().toLowerCase() === 'manager' && building) {
    const BuildingModel = require('../models/Building');
    try {
      const b = await BuildingModel.findById(building);
      if (b) {
        b.manager = newUser._id;
        await b.save();
      } else {
        console.warn('authController.register: provided building id not found', building);
      }
    } catch (err) {
      console.error('authController.register: failed to set building.manager', err);
    }
  }

  res.status(201).json({ message: 'Manager created', user: { _id: newUser._id, name, email, role, building } });
});


// --------------------- New admin endpoints ---------------------

// @desc    Get all managers
// @route   GET /api/auth/managers
// @access  Admin
exports.getManagers = asyncHandler(async (req, res) => {
  const managers = await User.find({ role: 'manager' }).populate('building', 'name');
  res.json(managers);
});

// @desc    Update manager password
// @route   PUT /api/auth/managers/:id
// @access  Admin
// Update manager details (password & building optional)
exports.updateManager = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { name, password, building } = req.body;

  const manager = await User.findById(id);
  if (!manager) return res.status(404).json({ message: 'Manager not found' });
  if (manager.role !== 'manager') return res.status(403).json({ message: 'Forbidden: Not a manager' });

  if (name) manager.name = name;
  if (building) manager.building = building;
  if (password) manager.password = await bcrypt.hash(password, 10);

  await manager.save();
  res.json({ message: 'Manager updated successfully', manager });
});

// Delete a manager
exports.deleteManager = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const manager = await User.findById(id);
  if (!manager) return res.status(404).json({ message: 'Manager not found' });
  if (manager.role !== 'manager') return res.status(403).json({ message: 'Forbidden: Not a manager' });

  await manager.remove();
  res.json({ message: 'Manager deleted successfully' });
});

