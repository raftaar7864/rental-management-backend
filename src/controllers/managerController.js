// backend/src/controllers/managerController.js
const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');
const Room = require('../models/Room');
const Building = require('../models/Building');
const Tenant = require('../models/Tenant');
const User = require('../models/User');

/**
 * Resolve the list of building IDs that this user manages.
 * Priority:
 *  - if req.user.building is set (User.building), use it
 *  - else (future) we attempt to find Building.manager === user._id
 * Returns array of ObjectId (may be empty)
 */
const resolveManagerBuildingIds = async (user) => {
  if (!user) return [];
  if (user.building) {
    // user.building may be populated object or id
    const bid = (user.building._id ? user.building._id : user.building);
    return [bid];
  }
  // fallback: if Building has manager field in future
  const bs = await Building.find({ manager: user._id }).select('_id');
  return bs.map(b => b._id);
};

// GET /api/manager/rooms
exports.getRoomsForManager = asyncHandler(async (req, res) => {
  const user = req.user;
  const buildingIds = await resolveManagerBuildingIds(user);

  if (!buildingIds.length) {
    return res.json([]); // no buildings assigned to this manager
  }

  const rooms = await Room.find({ building: { $in: buildingIds } })
    .populate('building', 'name address')
    .populate({ path: 'tenants', select: 'fullName tenantId phone email moveInDate moveOutDate advancedAmount' });

  res.json(rooms);
});

// GET /api/manager/tenants/:roomId
exports.getTenantsForRoom = asyncHandler(async (req, res) => {
  const user = req.user;
  const { roomId } = req.params;
  if (!mongoose.Types.ObjectId.isValid(roomId)) return res.status(400).json({ message: 'Invalid room id' });

  const room = await Room.findById(roomId).populate('building', '_id name').populate({ path: 'tenants', select: 'fullName tenantId phone email moveInDate moveOutDate advancedAmount' });
  if (!room) return res.status(404).json({ message: 'Room not found' });

  // Ownership check: compare room.building._id with user.building (or allow admin)
  if (user.role !== 'admin') {
    const userBuildingId = user.building && (user.building._id ? user.building._id.toString() : user.building.toString());
    const roomBuildingId = room.building && room.building._id ? room.building._id.toString() : null;
    if (!userBuildingId || userBuildingId !== roomBuildingId) {
      return res.status(403).json({ message: 'Forbidden: you do not manage this building' });
    }
  }

  return res.json(room.tenants || []);
});

exports.getTenantsByBuildings = async (req, res) => {
  try {
    const raw = req.query.buildings || "";
    const buildingIds = raw.split(",").map(s => s.trim()).filter(Boolean);
    if (!buildingIds.length) {
      return res.status(400).json({ message: "building ids are required" });
    }

    // Find rooms that belong to the given buildings
    const rooms = await Room.find({ building: { $in: buildingIds } }).select("_id");
    const roomIds = rooms.map(r => r._id);

    // If no rooms for those buildings, return empty array early
    if (roomIds.length === 0) {
      return res.json([]);
    }

    // Find tenants whose room is in those roomIds
    const tenants = await Tenant.find({ room: { $in: roomIds } })
      .populate({ path: 'room', populate: { path: 'building' } });

    return res.json(tenants);
  } catch (err) {
    console.error('getTenantsByBuildings error:', err);
    return res.status(500).json({ message: err.message || 'Server error' });
  }
};



/**
 * POST /api/manager/rooms/:roomId/book
 * Body: { tenantId } OR { tenantData: { fullName, phone, email, numberOfPersons, ... } }
 *
 * This adds tenant to room.tenants array and sets tenant.room to the room.
 * It also appends to room.tenantHistory snapshot (bookingDate).
 */
exports.bookTenantIntoRoom = asyncHandler(async (req, res) => {
  const user = req.user;
  const { roomId } = req.params;
  const { tenantId, tenantData } = req.body;

  if (!mongoose.Types.ObjectId.isValid(roomId)) return res.status(400).json({ message: 'Invalid room id' });

  const room = await Room.findById(roomId).populate('building', '_id name');
  if (!room) return res.status(404).json({ message: 'Room not found' });

  // Ownership check (manager can only operate on their building)
  if (user.role !== 'admin') {
    const userBuildingId = user.building && (user.building._id ? user.building._id.toString() : user.building.toString());
    const roomBuildingId = room.building && room.building._id ? room.building._id.toString() : null;
    if (!userBuildingId || userBuildingId !== roomBuildingId) {
      return res.status(403).json({ message: 'Forbidden: you do not manage this building' });
    }
  }

  let tenant;
  if (tenantId) {
    if (!mongoose.Types.ObjectId.isValid(tenantId)) return res.status(400).json({ message: 'Invalid tenant id' });
    tenant = await Tenant.findById(tenantId);
    if (!tenant) return res.status(404).json({ message: 'Tenant not found' });
  } else if (tenantData) {
    // Basic validation: ensure required fields present for your Tenant model
    if (!tenantData.fullName || !tenantData.numberOfPersons) {
      return res.status(400).json({ message: 'Tenant data must include fullName and numberOfPersons' });
    }
    tenant = await Tenant.create(tenantData);
  } else {
    return res.status(400).json({ message: 'Provide tenantId or tenantData' });
  }

  // add to room.tenants if not already present
  room.tenants = room.tenants || [];
  if (!room.tenants.some(t => t.toString() === tenant._id.toString())) {
    room.tenants.push(tenant._id);

    // add a snapshot to tenantHistory
    room.tenantHistory = room.tenantHistory || [];
    room.tenantHistory.push({
      tenant: tenant._id,
      tenantId: tenant.tenantId || undefined,
      fullName: tenant.fullName || undefined,
      bookingDate: tenant.moveInDate || new Date()
    });

    room.isBooked = true;
    await room.save();
  }

  // update tenant current room and moveInDate
  tenant.room = room._id;
  tenant.moveInDate = tenant.moveInDate || new Date();
  await tenant.save();

  // return fresh room + tenant
  const updatedRoom = await Room.findById(room._id).populate({ path: 'tenants', select: 'fullName tenantId phone email moveInDate' });
  const updatedTenant = await Tenant.findById(tenant._id);

  return res.status(200).json({ message: 'Tenant booked into room', room: updatedRoom, tenant: updatedTenant });
});
