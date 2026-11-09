const express = require("express");
const {
  generateContent,
  getAllDrafts,
  getContentByDraftId,
  editContent,
  deleteContent,
} = require("../controllers/CreateContentController");
const { verifyToken } = require("../middleware/authMiddleware");
const router = express.Router();

router.post("/generate", verifyToken, generateContent);
router.get("/", verifyToken, getAllDrafts);
router.get("/:draftId", verifyToken, getContentByDraftId);
router.put("/edit/:id", verifyToken, editContent);
router.delete("/delete/:id", verifyToken, deleteContent);

module.exports = router;
