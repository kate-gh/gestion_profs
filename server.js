const bcrypt = require("bcryptjs");
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
  if (!token) return res.status(401).json({ error: "Accès refusé" });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

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

    req.user = user;
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

// Modification de la route de login
app.post("/api/login", async (req, res) => {
  const { email, password, userType } = req.body;

  try {
    let table, redirect;
    if (userType === "admin") {
      table = "admins";
      redirect = "/dashboard";
    } else {
      table = "professeurs";
      redirect = "/profile";
    }

    const [user] = await pool.query(`SELECT * FROM ${table} WHERE email = ?`, [
      email,
    ]);

    if (!user[0]) {
      return res.status(401).json({ error: "Identifiants invalides" });
    }

    // Vérification du mot de passe haché
    const isMatch = await bcrypt.compare(password, user[0].password);
    if (!isMatch) {
      return res.status(401).json({ error: "Identifiants invalides" });
    }

    const token = jwt.sign(
      {
        id: user[0].id,
        role: userType,
        ...(userType === "professeur" && { professorId: user[0].id }),
      },
      process.env.JWT_SECRET,
      { expiresIn: "1h" }
    );

    res.json({ token, redirect });
  } catch (err) {
    console.error("Erreur de connexion :", err);
    res.status(500).send("Erreur interne du serveur");
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
  upload.single("photo"),
  async (req, res) => {
    try {
      const { body } = req;
      const photo = req.file ? req.file.filename : null;
      let matieres = Array.isArray(body.matieres)
        ? body.matieres
        : body.matieres.split(",").map((m) => m.trim());
      // Récupérer l'ancienne photo avant la mise à jour
      const [[oldProf]] = await pool.query(
        "SELECT photo FROM professeurs WHERE id = ?",
        [req.user.id]
      );

      // Supprimer l'ancienne photo si elle existe
      if (oldProf.photo && photo) {
        const oldPhotoPath = path.join(uploadsDir, oldProf.photo);
        if (fs.existsSync(oldPhotoPath)) {
          fs.unlinkSync(oldPhotoPath);
        }
      }

      const result = await pool.query("UPDATE professeurs SET ? WHERE id = ?", [
        {
          ...body,
          matieres: JSON.stringify(matieres),
          photo: req.file?.filename || body.photo,
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
  // Vérifier que seul l'admin peut supprimer
  if (req.user.role !== "admin") {
    return res.status(403).json({ error: "Action non autorisée" });
  }

  const { id } = req.params;

  try {
    // Récupérer la photo avant suppression
    const [[prof]] = await pool.query(
      "SELECT photo FROM professeurs WHERE id = ?",
      [id]
    );

    if (!prof) {
      return res.status(404).json({ error: "Professeur non trouvé" });
    }

    // Supprimer le professeur
    const [result] = await pool.query("DELETE FROM professeurs WHERE id = ?", [
      id,
    ]);

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: "Professeur non trouvé" });
    }

    // Supprimer le fichier photo si existant
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

// Génération de carte professionnelle en PDF
/* app.get("/api/generate-card/:id", authenticate, async (req, res) => {
  // Vérification d'accès
  if (
    req.user.role === "professeur" &&
    req.user.id !== parseInt(req.params.id)
  ) {
    return res.status(403).send("Accès non autorisé");
  }
  const { id } = req.params;

  try {
    const [[prof]] = await pool.query(
      "SELECT * FROM professeurs WHERE id = ?",
      [id]
    );
    if (!prof) return res.status(404).send("Professeur non trouvé");

    // Configurer les en-têtes PDF
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=carte_${prof.nom}_${prof.prenom}.pdf`
    );

    // Création du document avec un format de carte
    const doc = new PDFDocument({
      size: [600, 380],
      margins: { top: 0, bottom: 0, left: 0, right: 0 },
      layout: "landscape",
    });
    doc.pipe(res);

    // Fond avec dégradé linéaire couvrant toute la carte
    const gradient = doc.linearGradient(0, 0, 600, 0);
    gradient.stop(0, "#f8f9fa").stop(1, "#e9ecef");
    doc.rect(0, 0, 600, 380).fill(gradient);

    // Optionnel : dessiner une bordure autour de la carte
    doc.rect(5, 5, 590, 370).lineWidth(2).strokeColor("#cccccc").stroke();

    // En-tête : Nom de l'université et titre de la carte
    doc
      .fontSize(20)
      .fillColor("#3b82f6")
      .text("Université Chouaib Doukkali", 20, 20, { width: 400 });
    doc
      .fontSize(12)
      .fillColor("#6b7280")
      .text("Carte Professionnelle", 20, 50, { width: 400 });

    // Photo du professeur (affichée à gauche)
    if (prof.photo) {
      const photoPath = path.join(uploadsDir, prof.photo);
      if (fs.existsSync(photoPath)) {
        doc.image(photoPath, 20, 80, { width: 100, height: 100 });
      }
    } else {
      // En absence de photo, afficher un placeholder
      doc.rect(20, 80, 100, 100).stroke();
      doc
        .fontSize(30)
        .fillColor("#cccccc")
        .text("?", 60, 110, { align: "center" });
    }

    // Informations du professeur (affichées à droite de la photo)
    doc
      .fontSize(16)
      .fillColor("#1e293b")
      .text(`${prof.prenom} ${prof.nom}`, 140, 80, { width: 300 });
    doc
      .fontSize(12)
      .fillColor("#64748b")
      .text(`Statut: ${prof.statut}`, 140, 110, { width: 300 });
    doc.text(`Email: ${prof.email}`, 140, 150, { width: 300 });
    // Matières enseignées (on essaie de parser le JSON, sinon on affiche tel quel)
    let matieresText = "";
    try {
      matieresText = JSON.parse(prof.matieres).join(", ");
    } catch (e) {
      matieresText = prof.matieres;
    }
    doc.text(`Matières: ${matieresText}`, 140, 130, { width: 300 });

    // QR Code : affiché sur le côté droit de la carte
    try {
      const qrUrl = await QRCode.toDataURL(
        `${process.env.FRONTEND_URL}/professeurs/${id}`,
        { errorCorrectionLevel: "H", width: 150 }
      );
      doc.image(qrUrl, 440, 80, { width: 120 });
    } catch (qrError) {
      console.error("Erreur QR Code:", qrError);
    }

    // Pied de page : barre en bas avec l'ID et la date de validité
    doc.rect(0, 350, 600, 30).fill("#3b82f6");
    doc
      .fillColor("#1e293b")
      .fontSize(10)
      .text(`ID: ${prof.id}`, 20, 357, { width: 200, align: "left" })
      .text(`Valide jusqu'au ${new Date().getFullYear() + 1}`, 380, 357, {
        width: 200,
        align: "right",
      });

    doc.end();
  } catch (err) {
    console.error("Erreur PDF:", err);
    res.status(500).send("Erreur lors de la génération du PDF");
  }
});
*/
/*
app.get("/api/generate-card/:id", authenticate, async (req, res) => {
  // Vérification d'accès
  if (
    req.user.role === "professeur" &&
    req.user.id !== parseInt(req.params.id)
  ) {
    return res.status(403).send("Accès non autorisé");
  }
  const { id } = req.params;

  try {
    const [[prof]] = await pool.query(
      "SELECT * FROM professeurs WHERE id = ?",
      [id]
    );
    if (!prof) return res.status(404).send("Professeur non trouvé");

    // Configurer les en-têtes PDF
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=carte_${prof.nom}_${prof.prenom}.pdf`
    );

    // Création du document avec une taille fixe (600 x 380) et sans marges
    const doc = new PDFDocument({
      size: [340, 216], // Format carte de crédit (85mm x 54mm en 96 DPI)
      margins: { top: 10, bottom: 10, left: 10, right: 10 },
    });
    doc.pipe(res);

    // Fond : dégradé linéaire sur toute la carte
    const gradient = doc.linearGradient(0, 0, 340, 216);
    gradient.stop(0, "#f8fafc").stop(1, "#e2e8f0");
    doc.rect(0, 0, 340, 216).fill(gradient);

    // Bordure stylisée
    doc.roundedRect(5, 5, 330, 206, 8).lineWidth(2).stroke("#cbd5e1");

    // En-tête
    doc
      .fontSize(12)
      .fill("#1e40af")
      .text("Université Chouaib Doukkali", 20, 15, {
        width: 300,
        align: "center",
      });

    doc
      .fontSize(8)
      .fill("#475569")
      .text("Carte Professionnelle", 20, 30, { width: 300, align: "center" });
    // QR Code
    const qrUrl = await QRCode.toDataURL(
      `${process.env.FRONTEND_URL}/professeurs/${id}`,
      { errorCorrectionLevel: "H", width: 100 }
    );
    doc.image(qrUrl, 230, 40, { width: 80, height: 80 });

    // Photo
    if (prof.photo) {
      const photoPath = path.join(uploadsDir, prof.photo);
      if (fs.existsSync(photoPath)) {
        doc.roundedRect(20, 60, 80, 80, 8).fill("#ffffff");
        doc.image(photoPath, 25, 65, { width: 70, height: 70 });
      }
    } else {
      // Si aucune photo, afficher un placeholder
      doc.rect(20, 80, 100, 100).stroke();
      doc.fontSize(30).fillColor("#cccccc").text("?", 60, 110, {
        align: "center",
      });
    }

    // Informations
    doc
      .fontSize(14)
      .fill("#1e293b")
      .text(`${prof.prenom} ${prof.nom}`, 110, 90, { width: 200 });

    doc.fontSize(10).fill("#3b82f6").text(prof.statut, 110, 110);

    doc.fontSize(9).fill("#64748b").text(prof.email, 110, 125, { width: 200 });

    // Traitement des matières
    let matieresText = "";
    try {
      matieresText = JSON.parse(prof.matieres).join(", ");
    } catch (e) {
      matieresText = prof.matieres;
    }
    doc.fontSize(8).fill("#475569").text("Matières enseignées:", 20, 145);
    doc.text(matieresText, 20, 155, { width: 200 });

    // Footer
    doc.rect(0, 190, 340, 26).fill("#1e40af");
    doc
      .fontSize(8)
      .fill("white")
      .text(`Valide jusqu'au ${new Date().getFullYear() + 1}`, 20, 197)
      .text("www.ucd.ac.ma", 240, 197, { align: "right" });

    doc.end();
  } catch (err) {
    console.error("Erreur PDF:", err);
    res.status(500).send("Erreur lors de la génération du PDF");
  }
});*/

app.get("/api/generate-card/:id", authenticate, async (req, res) => {
  // Vérification d'accès
  if (
    req.user.role === "professeur" &&
    req.user.id !== parseInt(req.params.id)
  ) {
    return res.status(403).send("Accès non autorisé");
  }

  const { id } = req.params;

  try {
    const [[prof]] = await pool.query(
      "SELECT * FROM professeurs WHERE id = ?",
      [id]
    );
    if (!prof) return res.status(404).send("Professeur non trouvé");

    // Configurer les en-têtes PDF
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=carte_${prof.nom}_${prof.prenom}.pdf`
    );

    // Création du document (format carte de crédit 340x216, marges de 10)
    const doc = new PDFDocument({
      size: [340, 216],
      margins: { top: 10, bottom: 10, left: 10, right: 10 },
    });
    doc.pipe(res);

    // =========================
    // 1. Fond et bordure arrondie
    // =========================
    // Dégradé linéaire du haut vers le bas
    const gradient = doc.linearGradient(0, 0, 0, 216);
    gradient.stop(0, "#ffffff").stop(1, "#f3f4f6");

    // On dessine un rectangle arrondi qui remplit toute la zone de la carte
    doc.save();
    doc
      .roundedRect(5, 5, 330, 206, 15) // bords arrondis à 15 px
      .fill(gradient);
    doc.restore();

    // Bordure autour de la carte
    doc.roundedRect(5, 5, 330, 206, 15).lineWidth(1).stroke("#cbd5e1");

    // =========================
    // 2. En-tête
    // =========================
    doc
      .fontSize(12)
      .fillColor("#1e40af")
      .font("Helvetica-Bold")
      .text("Université Chouaib Doukkali", 0, 15, {
        width: 340,
        align: "center",
      });

    doc
      .fontSize(9)
      .fillColor("#475569")
      .font("Helvetica")
      .text("Carte d'Enseignant", 0, 32, {
        width: 340,
        align: "center",
      });

    // =========================
    // 3. QR Code en haut à droite
    // =========================
    const qrUrl = await QRCode.toDataURL(
      `${process.env.FRONTEND_URL}/professeurs/${id}`,
      { errorCorrectionLevel: "H", width: 80 }
    );
    doc.image(qrUrl, 280, 15, { width: 45, height: 45 });

    // =========================
    // 4. Photo circulaire (ou placeholder)
    // =========================
    // Coordonnées du centre du cercle
    const photoCenterX = 50;
    const photoCenterY = 100;
    const photoRadius = 25;

    doc.save();
    // On dessine un cercle (photo de profil)
    doc
      .circle(photoCenterX, photoCenterY, photoRadius)
      .fill("#f8fafc") // Couleur de fond (blanc/gris clair)
      .clip(); // On "clipe" pour insérer la photo dans ce cercle

    // Si on a un chemin de photo valide
    if (prof.photo) {
      const photoPath = path.join(uploadsDir, prof.photo);
      if (fs.existsSync(photoPath)) {
        // On affiche la photo dans la zone clippée
        doc.image(
          photoPath,
          photoCenterX - photoRadius,
          photoCenterY - photoRadius,
          {
            width: photoRadius * 2,
            height: photoRadius * 2,
            //cover: true, // pour remplir le cercle
          }
        );
      } else {
        // Sinon un placeholder (icône, etc.)
        doc
          .fontSize(20)
          .fillColor("#cccccc")
          .text("?", photoCenterX - 5, photoCenterY - 10);
      }
    } else {
      // Placeholder si aucune photo
      doc
        .fontSize(20)
        .fillColor("#cccccc")
        .text("?", photoCenterX - 5, photoCenterY - 10);
    }
    doc.restore();

    // =========================
    // 5. Informations du professeur
    // =========================
    // Position du bloc de texte à droite de la photo
    const infoX = 90;
    let infoY = 80;

    // Nom complet
    doc
      .font("Helvetica-Bold")
      .fontSize(12)
      .fillColor("#1e293b")
      .text(`${prof.prenom} ${prof.nom}`, infoX, infoY);

    infoY += 20; // espace en dessous du nom

    // Statut
    doc
      .font("Helvetica")
      .fontSize(10)
      .fillColor("#3b82f6")
      .text(prof.statut, infoX, infoY);

    infoY += 15;

    // Email
    doc
      .font("Helvetica")
      .fontSize(9)
      .fillColor("#64748b")
      .text(prof.email, infoX, infoY);

    infoY += 20;

    // =========================
    // 6. Matières (bulle ou simple texte)
    // =========================
    let matieresText = "";
    try {
      matieresText = JSON.parse(prof.matieres).join(", ");
    } catch (e) {
      matieresText = prof.matieres;
    }

    // Ou si vous préférez juste un texte standard :
    doc
      .fontSize(8)
      .fillColor("#475569")
      .text(`Matières: ${matieresText}`, infoX, infoY);

    // =========================
    // 7. Pied de page
    // =========================
    // On place un petit rectangle ou juste du texte
    // Sur l'image exemple, le pied de page est discret et sans fond coloré
    const footerY = 190;
    doc
      .fontSize(8)
      .fillColor("#475569")
      .text(`Valide jusqu'au ${new Date().getFullYear() + 1}`, 20, footerY);

    doc.fontSize(8).fillColor("#475569").text("www.ucd.ac.ma", 0, footerY, {
      align: "right",
      width: 320,
    });

    doc.end();
  } catch (err) {
    console.error("Erreur PDF:", err);
    res.status(500).send("Erreur lors de la génération du PDF");
  }
});

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
