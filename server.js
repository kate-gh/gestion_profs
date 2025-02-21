const bcrypt = require("bcryptjs");
require("dotenv").config();
const express = require("express");
const mysql = require("mysql2/promise");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const xlsx = require("xlsx");
const PDFDocument = require("pdfkit");
const archiver = require("archiver");
const QRCode = require("qrcode");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const { PassThrough } = require("stream");
const app = express();
app.use(
  cors({
    origin: "http://localhost:3000", // Port du frontend Next.js
  })
);
app.use(express.json());
app.use("/uploads", express.static("uploads"));

// Configuration de la base de données
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

// Middleware d'authentification JWT
const authenticate = async (req, res, next) => {
  const token = req.header("Authorization")?.replace("Bearer ", "");
  if (!token) return res.status(401).json({ error: "Accès refusé" });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (!decoded.role || !["admin", "professeur"].includes(decoded.role)) {
      throw new Error("Role JWT invalide");
    }
    // Vérification des rôles autorisés
    if (!["admin", "professeur"].includes(decoded.role)) {
      throw new Error("Rôle invalide");
    }

    let user;
    const query =
      decoded.role === "admin"
        ? "SELECT * FROM admins WHERE id = ?"
        : "SELECT * FROM professeurs WHERE id = ?";

    const [results] = await pool.query(query, [decoded.id]);

    if (!results.length) throw new Error("Utilisateur non trouvé");
    user = results[0];

    req.user = {
      ...results[0],
      role: decoded.role, // Priorité au rôle du JWT
    };
    next();
  } catch (err) {
    res.status(401).json({ error: "Session invalide" });
  }
};

// Configuration du répertoire uploads
const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Configuration de Multer pour les uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, "uploads/"); // assure-toi que ce dossier existe
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname}`);
  },
});
const upload = multer({ storage });

app.post("/api/login", async (req, res) => {
  const { email, password, userType } = req.body;

  try {
    // Validation du type utilisateur
    if (!["admin", "professeur"].includes(userType)) {
      return res.status(400).json({ error: "Type utilisateur invalide" });
    }

    const table = userType === "admin" ? "admins" : "professeurs";

    // Requête sécurisée
    const [users] = await pool.query(
      `SELECT id, password FROM ${table} WHERE email = ? LIMIT 1`,
      [email]
    );

    if (!users.length) {
      return res.status(401).json({ error: "Identifiants invalides" });
    }

    // Vérification mot de passe
    const isMatch = await bcrypt.compare(password, users[0].password);
    if (!isMatch) {
      return res.status(401).json({ error: "Identifiants invalides" });
    }

    // Génération JWT avec rôle forcé
    const token = jwt.sign(
      {
        id: users[0].id,
        role: userType, // Role strict depuis le front
        origin: "login",
      },
      process.env.JWT_SECRET,
      { expiresIn: "1h" }
    );

    res.json({
      token,
      redirect: userType === "admin" ? "/dashboard" : "/profile",
    });
  } catch (err) {
    console.error(`Login error: ${err.message}`);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// Route pour récupérer tous les professeurs
app.get("/api/professeurs", authenticate, async (req, res) => {
  try {
    const [professeurs] = await pool.query("SELECT * FROM professeurs");
    // Convertir le JSON matieres en chaîne pour le frontend
    const formatted = professeurs.map((p) => ({
      ...p,
      matieres: p.matieres ? JSON.parse(p.matieres) : [], // Ajout d'une vérification
    }));
    res.json(formatted);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

app.post(
  "/api/professeurs",
  authenticate,
  upload.single("photo"),
  async (req, res) => {
    const { body, file } = req;
    try {
      // Hachage du mot de passe
      const salt = await bcrypt.genSalt(10);
      const hashedPassword = await bcrypt.hash(body.password, salt);

      let matieres = Array.isArray(body.matieres)
        ? body.matieres
        : body.matieres.split(",").map((m) => m.trim());

      const result = await pool.query(`INSERT INTO professeurs SET ?`, {
        ...body,
        password: hashedPassword,
        photo: file ? file.filename : null,
        matieres: JSON.stringify(matieres),
      });

      res.status(201).json({ id: result[0].insertId });
    } catch (err) {
      res.status(400).send(err.message);
    }
  }
);

// Route pour récupérer le profil du professeur connecté
app.get("/api/professeurs/me", authenticate, async (req, res) => {
  try {
    const [prof] = await pool.query("SELECT * FROM professeurs WHERE id = ?", [
      req.user.id,
    ]);
    if (!prof.length) return res.status(404).send("Professeur non trouvé");

    // Conversion des matières en tableau
    const formatted = {
      ...prof[0],
      matieres: prof[0].matieres ? JSON.parse(prof[0].matieres) : [],
    };

    res.json(formatted);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// Route pour mettre à jour le profil du professeur connecté
app.put(
  "/api/professeurs/me",
  authenticate,
  upload.single("newPhoto"),
  async (req, res) => {
    try {
      const { body } = req;
      const newPhoto = req.file;

      const photoToUse = newPhoto ? newPhoto.filename : body.photo; // Photo existante du formulaire

      let matieres = Array.isArray(body.matieres)
        ? body.matieres
        : body.matieres.split(",").map((m) => m.trim());
      // Récupérer l'ancienne photo avant la mise à jour
      const [[oldProf]] = await pool.query(
        "SELECT photo FROM professeurs WHERE id = ?",
        [req.user.id]
      );

      // Supprimer l'ancienne photo si elle existe
      if (newPhoto && oldProf.photo) {
        const oldPhotoPath = path.join(uploadsDir, oldProf.photo);
        if (fs.existsSync(oldPhotoPath)) {
          fs.unlinkSync(oldPhotoPath);
        }
      }

      const result = await pool.query("UPDATE professeurs SET ? WHERE id = ?", [
        {
          ...body,
          matieres: JSON.stringify(matieres),
          photo: photoToUse,
        },
        req.user.id,
      ]);

      if (result.affectedRows === 0) {
        return res.status(404).send("Professeur non trouvé");
      }

      res.json({ message: "Profil mis à jour" });
    } catch (err) {
      console.error(err);
      res.status(500).send("Erreur du serveur");
    }
  }
);

// Ajouter cette route après les autres routes CRUD pour les professeurs
app.delete("/api/professeurs/:id", authenticate, async (req, res) => {
  if (req.user.role !== "admin") {
    return res.status(403).json({ error: "Action non autorisée" });
  }

  const { id } = req.params;
  const professeurId = parseInt(id, 10); // Conversion en nombre

  if (isNaN(professeurId)) {
    return res.status(400).json({ error: "ID invalide" });
  }

  try {
    // Utiliser l'ID converti dans les requêtes SQL
    const [[prof]] = await pool.query(
      "SELECT photo FROM professeurs WHERE id = ?",
      [professeurId]
    );

    if (!prof) {
      return res.status(404).json({ error: "Professeur non trouvé" });
    }

    const [result] = await pool.query("DELETE FROM professeurs WHERE id = ?", [
      professeurId,
    ]);

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: "Professeur non trouvé" });
    }

    if (prof.photo) {
      const photoPath = path.join(uploadsDir, prof.photo);
      if (fs.existsSync(photoPath)) {
        fs.unlinkSync(photoPath);
      }
    }

    res.json({ message: "Professeur supprimé avec succès" });
  } catch (err) {
    console.error("Erreur suppression:", err);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// Importation Excel
app.post(
  "/api/upload-excel",
  authenticate,
  upload.single("file"),
  async (req, res) => {
    try {
      const workbook = xlsx.readFile(req.file.path);
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const data = xlsx.utils.sheet_to_json(sheet);

      const validData = data.map((row) => ({
        ...row,
        matieres: JSON.stringify(
          row.matieres?.split(",").map((m) => m.trim()) || []
        ),
      }));

      // Utiliser une transaction pour les insertions multiples
      const connection = await pool.getConnection();
      await connection.beginTransaction();

      try {
        for (const row of validData) {
          await connection.query("INSERT INTO professeurs SET ?", row);
        }
        await connection.commit();
        res.send("Importation réussie");
      } catch (err) {
        await connection.rollback();
        throw err;
      } finally {
        connection.release();
      }
    } catch (err) {
      res.status(400).send("Erreur d'importation: " + err.message);
    }
  }
);

// Création de la table professeurs (si elle n'existe pas)
async function initializeDB() {
  // Modification de la table professeurs
  const createTableQuery = `
CREATE TABLE IF NOT EXISTS professeurs (
  id INT PRIMARY KEY AUTO_INCREMENT,
  nom VARCHAR(255) NOT NULL,
  prenom VARCHAR(255) NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  password VARCHAR(255) NOT NULL,
  telephone VARCHAR(20),
  matieres JSON,
  statut ENUM('permanent', 'vacataire') NOT NULL,
  photo VARCHAR(255),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)`;

  await pool.query(createTableQuery);
}

// Exemple de création de la table admins (si besoin)
async function initializeAdmins() {
  const createAdminsQuery = `
    CREATE TABLE IF NOT EXISTS admins (
      id INT PRIMARY KEY AUTO_INCREMENT,
      email VARCHAR(255) UNIQUE NOT NULL,
      password VARCHAR(255) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`;
  await pool.query(createAdminsQuery);

  // Insertion d'un admin test si aucun n'existe
  const [rows] = await pool.query("SELECT COUNT(*) as count FROM admins");
  if (rows[0].count === 0) {
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash("123", salt);

    await pool.query("INSERT INTO admins (email, password) VALUES (?, ?)", [
      "admin@email.com",
      hashedPassword,
    ]);
  }
}

Promise.all([initializeDB(), initializeAdmins()])
  .then(() => {
    app.listen(process.env.PORT, () => {
      console.log(`Serveur démarré sur le port ${process.env.PORT}`);
    });
  })
  .catch((err) => {
    console.error("Erreur lors de l'initialisation de la DB : ", err);
  });
