require("dotenv").config();
const express = require("express");
const mysql = require("mysql2/promise");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const xlsx = require("xlsx");
const PDFDocument = require("pdfkit");
const QRCode = require("qrcode");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

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
  if (!token) return res.status(401).send("Accès refusé");

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const [user] = await pool.query("SELECT * FROM admins WHERE id = ?", [
      decoded.id,
    ]);
    if (!user[0]) throw new Error();
    req.user = user[0];
    next();
  } catch (err) {
    res.status(401).send("Token invalide");
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

// Route d'authentification
app.post("/api/login", async (req, res) => {
  const { email, password } = req.body;
  try {
    const [admin] = await pool.query(
      "SELECT * FROM admins WHERE email = ? AND password = ?",
      [email, password]
    );
    if (admin.length === 0) {
      return res.status(401).json({ error: "Identifiants invalides" });
    }
    const token = jwt.sign({ id: admin[0].id }, process.env.JWT_SECRET, {
      expiresIn: "1h",
    });
    res.json({ token });
  } catch (err) {
    res.status(500).send(err.message);
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
      let matieres = Array.isArray(body.matieres)
        ? body.matieres
        : body.matieres.split(",").map((m) => m.trim());

      const result = await pool.query(`INSERT INTO professeurs SET ?`, {
        ...body,
        photo: file ? file.filename : null,
        matieres: JSON.stringify(matieres),
      });

      res.status(201).json({ id: result[0].insertId });
    } catch (err) {
      res.status(400).send(err.message);
    }
  }
);

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

// Génération de carte professionnelle en PDF
app.get("/api/generate-card/:id", authenticate, async (req, res) => {
  const { id } = req.params;

  try {
    const [[prof]] = await pool.query(
      "SELECT * FROM professeurs WHERE id = ?",
      [id]
    );

    if (!prof) {
      return res.status(404).send("Professeur non trouvé");
    }

    // Création du PDF
    const doc = new PDFDocument({ size: "A6", margin: 20 });
    const pdfPath = `./public/cards/prof_${id}.pdf`;
    const stream = fs.createWriteStream(pdfPath);
    doc.pipe(stream);

    // Ajout du nom et prénom
    doc.fontSize(18).text(`${prof.nom} ${prof.prenom}`, { align: "center" });

    // Ajout de la photo si disponible
    if (prof.photo) {
      const photoPath = path.join(__dirname, "uploads", prof.photo);
      if (fs.existsSync(photoPath)) {
        doc.image(photoPath, { width: 100, height: 100, align: "center" });
      }
    }

    // Matières enseignées
    const matieres = JSON.parse(prof.matieres || "[]").join(", ");
    doc
      .moveDown()
      .fontSize(14)
      .text(`Matières : ${matieres}`, { align: "center" });

    // Génération du QR Code
    const qrCode = qr.imageSync(`http://localhost:3000/professeur/${id}`, {
      type: "png",
    });
    const qrPath = `./public/qrcodes/qr_${id}.png`;
    fs.writeFileSync(qrPath, qrCode);
    doc.image(qrPath, { width: 100, align: "center" });

    // Finaliser et fermer le document
    doc.end();

    stream.on("finish", () => {
      res.download(pdfPath, `carte_prof_${id}.pdf`, () => {
        fs.unlinkSync(pdfPath); // Supprime le fichier après téléchargement
      });
    });
  } catch (err) {
    console.error("Erreur PDF:", err);
    res.status(500).send("Erreur lors de la génération du PDF");
  }
});

// Création de la table professeurs (si elle n'existe pas)
async function initializeDB() {
  const createTableQuery = `
    CREATE TABLE IF NOT EXISTS professeurs (
      id INT PRIMARY KEY AUTO_INCREMENT,
      nom VARCHAR(255) NOT NULL,
      prenom VARCHAR(255) NOT NULL,
      email VARCHAR(255) UNIQUE NOT NULL,
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
    await pool.query("INSERT INTO admins (email, password) VALUES (?, ?)", [
      "admin@example.com",
      "password",
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
