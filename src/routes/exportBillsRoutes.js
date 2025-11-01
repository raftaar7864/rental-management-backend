// server/src/routes/exportBills.js (example)
import express from "express";
import ExcelJS from "exceljs";
import Bill from "../models/Bill"; // your bill model

const router = express.Router();

router.get("/export/bills", async (req, res) => {
  try {
    const bills = await Bill.find({}).populate("tenant room"); // adjust query

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Bills");

    ws.columns = [
      { header: "#", key: "idx", width: 6 },
      { header: "Tenant", key: "tenant", width: 30 },
      { header: "Room", key: "room", width: 12 },
      { header: "Month", key: "month", width: 12 },
      { header: "Amount", key: "amount", width: 12 },
      { header: "Status", key: "status", width: 12 },
      { header: "PaidAt", key: "paidAt", width: 20 },
    ];

    bills.forEach((b, i) => {
      ws.addRow({
        idx: i + 1,
        tenant: b.tenant?.fullName || b.tenantId || "-",
        room: b.room?.number || "-",
        month: b.billingMonth ? String(b.billingMonth).slice(0, 7) : "-",
        amount: Number(b.totalAmount || 0),
        status: b.paymentStatus || b.status || "-",
        paidAt: b.paidDate || b.paidAt || "",
      });
    });

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="bills_${new Date().toISOString().slice(0,10)}.xlsx"`);

    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error(err);
    res.status(500).send("Export failed");
  }
});

export default router;
