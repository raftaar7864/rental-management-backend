// backend/src/controllers/roomController.js
const mongoose = require('mongoose');
const Room = require('../models/Room');
const Building = require('../models/Building');
const Tenant = require('../models/Tenant');

// ---------------- Helper: populate room with building and tenant info ----------------
async function populateRoom(roomId) {
  const roomDoc = await Room.findById(roomId)
    .populate("building", "name")
    .populate("tenants", "fullName tenantId rentAmount moveInDate moveOutDate")
    .populate("tenantHistory.tenant", "fullName tenantId rentAmount")
    .lean();

  if (!roomDoc) return null;

  // pick first active tenant
  const activeTenant = (roomDoc.tenants || []).find((t) => !t.moveOutDate);
  const rent = activeTenant ? Number(activeTenant.rentAmount || 0) : null;

  return {
    _id: roomDoc._id,
    building: roomDoc.building ? roomDoc.building.name : "",
    number: roomDoc.number,
    roomNumber: roomDoc.roomNumber,
    rent: rent,
    tenants: roomDoc.tenants,
    tenantHistory: roomDoc.tenantHistory,
    isBooked: roomDoc.isBooked,
  };
}

// ---------------- Create Room ----------------
exports.createRoom = async (req, res) => {
  try {
    const { number, buildingId } = req.body;

    if (!number || !buildingId) {
      return res.status(400).json({ message: "Room number and building are required" });
    }

    if (!mongoose.Types.ObjectId.isValid(buildingId)) {
      return res.status(400).json({ message: "Invalid building id" });
    }

    const building = await Building.findById(buildingId);
    if (!building) return res.status(404).json({ message: "Building not found" });

    const exists = await Room.findOne({ building: buildingId, number });
    if (exists) return res.status(400).json({ message: "Room number already exists in this building" });

    const room = new Room({
      number,
      roomNumber: number,
      building: buildingId,
      tenants: [],
      tenantHistory: [],
      isBooked: false,
    });

    await room.save();

    if (!Array.isArray(building.rooms)) building.rooms = [];
    if (!building.rooms.some((rid) => rid.toString() === room._id.toString())) {
      building.rooms.push(room._id);
      await building.save();
    }

    const created = await populateRoom(room._id);
    return res.status(201).json(created);
  } catch (err) {
    console.error("Error creating room:", err);
    if (err.code === 11000)
      return res.status(400).json({ message: "Duplicate room number in this building" });
    return res.status(500).json({ message: err.message || "Server error" });
  }
};

// ---------------- Get Rooms By Building ----------------
exports.getRoomsByBuilding = async (req, res) => {
  try {
    const { buildingId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(buildingId))
      return res.status(400).json({ message: 'Invalid building id' });

    const rooms = await Room.find({ building: buildingId });
    const result = await Promise.all(rooms.map(r => populateRoom(r._id)));
    res.json(result);
  } catch (err) {
    console.error('Error fetching rooms by building:', err);
    res.status(500).json({ message: 'Server error fetching rooms' });
  }
};

// ---------------- Update Room ----------------
exports.updateRoom = async (req, res) => {
  try {
    const { id } = req.params;
    const { number } = req.body;
    if (!number) return res.status(400).json({ message: 'Room number is required' });

    const room = await Room.findById(id);
    if (!room) return res.status(404).json({ message: 'Room not found' });

    if (room.number !== number) {
      const exists = await Room.findOne({ building: room.building, number });
      if (exists) return res.status(400).json({ message: 'Another room with this number exists in the building' });
    }

    room.number = number;
    room.roomNumber = number; // keep roomNumber in sync
    await room.save();

    const updated = await populateRoom(room._id);
    res.json(updated);
  } catch (err) {
    console.error('Error updating room:', err);
    if (err.code === 11000)
      return res.status(400).json({ message: 'Duplicate room number in this building' });
    res.status(500).json({ message: 'Server error updating room' });
  }
};

// ---------------- Get All Rooms ----------------
exports.getAllRooms = async (req, res) => {
  try {
    const rooms = await Room.find();
    const result = await Promise.all(rooms.map(r => populateRoom(r._id)));
    res.json(result);
  } catch (err) {
    console.error('Error fetching all rooms:', err);
    res.status(500).json({ message: err.message || 'Server error' });
  }
};

// ---------------- Get Rooms For Manager ----------------
exports.getRoomsForManager = async (req, res) => {
  try {
    const managerId = req.user._id;
    const buildings = await Building.find({ manager: managerId });
    const rooms = await Room.find({ building: { $in: buildings.map(b => b._id) } });
    const result = await Promise.all(rooms.map(r => populateRoom(r._id)));
    res.json(result);
  } catch (err) {
    console.error('Error fetching rooms for manager:', err);
    res.status(500).json({ message: 'Server error fetching rooms for manager' });
  }
};

// ---------------- Assign Tenant ----------------
exports.assignTenant = async (req, res) => {
  try {
    const { id: roomId } = req.params;
    const { tenantId, startDate } = req.body;

    if (!tenantId) return res.status(400).json({ message: 'tenantId required' });
    if (!mongoose.Types.ObjectId.isValid(roomId) || !mongoose.Types.ObjectId.isValid(tenantId))
      return res.status(400).json({ message: 'Invalid IDs' });

    const room = await Room.findById(roomId);
    if (!room) return res.status(404).json({ message: 'Room not found' });

    if (room.tenants.some(t => t.toString() === tenantId.toString()))
      return res.status(400).json({ message: 'Tenant already assigned to this room' });

    room.tenants.push(tenantId);
    room.tenantHistory.push({
      tenant: tenantId,
      startDate: startDate ? new Date(startDate) : new Date(),
      endDate: null,
    });

    room.isBooked = room.tenants.length > 0;
    await room.save();

    const populated = await populateRoom(room._id);
    res.json({ message: 'Tenant assigned', room: populated });
  } catch (err) {
    console.error('assignTenant error:', err);
    res.status(500).json({ message: 'Server error assigning tenant' });
  }
};

// ---------------- Update Tenant ----------------
exports.updateTenant = async (req, res) => {
  try {
    const { id } = req.params;
    const tenant = await Tenant.findById(id);
    if (!tenant) return res.status(404).json({ message: 'Tenant not found' });

    const {
      fullName,
      phone,
      idProofType,
      idProofNumber,
      advancedAmount,
      rentAmount,
      numberOfPersons,
      moveInDate,
      moveOutDate
    } = req.body;

    if (fullName !== undefined) tenant.fullName = fullName;
    if (phone !== undefined) tenant.phone = phone;
    if (idProofType !== undefined) tenant.idProofType = idProofType;
    if (idProofNumber !== undefined) tenant.idProofNumber = idProofNumber;
    if (advancedAmount !== undefined) tenant.advancedAmount = advancedAmount;
    if (rentAmount !== undefined) tenant.rentAmount = Number(rentAmount);
    if (numberOfPersons !== undefined) tenant.numberOfPersons = numberOfPersons;
    if (moveInDate !== undefined) tenant.moveInDate = new Date(moveInDate);
    if (moveOutDate !== undefined) tenant.moveOutDate = moveOutDate ? new Date(moveOutDate) : null;

    await tenant.save();

    res.json({ message: 'Tenant updated successfully', tenant });
  } catch (err) {
    console.error('updateTenant error:', err);
    res.status(500).json({ message: 'Server error updating tenant' });
  }
};

// ---------------- Remove Tenant ----------------
exports.removeTenant = async (req, res) => {
  try {
    const { id: roomId } = req.params;
    const { tenantId, leavingDate } = req.body;

    if (!tenantId) return res.status(400).json({ message: 'tenantId required' });

    const room = await Room.findById(roomId);
    if (!room) return res.status(404).json({ message: 'Room not found' });

    const beforeCount = room.tenants.length;
    room.tenants = room.tenants.filter(t => t.toString() !== tenantId.toString());
    if (beforeCount === room.tenants.length) {
      return res.status(400).json({ message: 'Tenant not found in this room' });
    }

    for (let i = room.tenantHistory.length - 1; i >= 0; i--) {
      const entry = room.tenantHistory[i];
      if (entry.tenant && entry.tenant.toString() === tenantId.toString() && !entry.endDate) {
        entry.endDate = leavingDate ? new Date(leavingDate) : new Date();
        break;
      }
    }

    room.isBooked = room.tenants.length > 0;
    await room.save();

    const populated = await populateRoom(room._id);
    res.json({ message: 'Tenant removed', room: populated });
  } catch (err) {
    console.error('removeTenant error:', err);
    res.status(500).json({ message: 'Server error removing tenant' });
  }
};
