const Building = require('../models/Building');

// Create building
exports.createBuilding = async (req, res) => {
  try {
    const { name, address } = req.body;
    if (!name) return res.status(400).json({ message: 'Name is required' });
    const building = await Building.create({ name, address });
    res.json(building);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// Get all buildings
exports.getBuildings = async (req, res) => {
  try {
    const buildings = await Building.find();
    res.json(buildings);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// Update building
exports.updateBuilding = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, address } = req.body;

    const building = await Building.findByIdAndUpdate(
      id,
      { name, address },
      { new: true }
    );

    if (!building) return res.status(404).json({ message: "Building not found" });

    res.json(building);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
