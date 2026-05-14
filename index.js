const express = require("express");
const cors = require("cors");
const app = express();
const port = process.env.PORT || 5000;
require("dotenv").config();
const { MongoClient, ServerApiVersion } = require("mongodb");

// middlewares
app.use(cors());
app.use(express.json());

const admin = require("firebase-admin");
const serviceAccount = require("./digital-life-lesson-firebase-adminsdk.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const verifyFBToken = async (req, res, next) => {
  const token = req.headers.authorization;
  console.log(token);

  if (!token) {
    return res.status(401).send({ message: "1.Unauthorized Access" });
  }
  try {
    const idToken = token.split(" ")[1];
    const decoded = await admin.auth().verifyIdToken(idToken);
    req.decoded_email = decoded.email;
    next();
  } catch (error) {
    return res.status(401).send({ message: "2.Unauthorized Access" });
  }
};

app.get("/", (req, res) => {
  res.send("Life Lesson Server is Running!");
});

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.ci4q50w.mongodb.net/?appName=Cluster0`;
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!",
    );

    const db = client.db("life-lesson-db");
    const usersCollection = db.collection("users");
    const lessonsCollection = db.collection("lessons");

    // lesson related apis
    app.post("/lessons", verifyFBToken, async (req, res) => {
      const lesson = req.body;
      console.log(lesson);
      
      const { authorEmail } = req.body;
      if (authorEmail !== req.decoded_email) {
        return res.status(403).send({ message: "Forbidden Access" });
      }
      const result = await lessonsCollection.insertOne(lesson);
      res.send(result);
    });

    // user related apis:
    app.get("/users", verifyFBToken, async (req, res) => {
      const { email } = req.query;
      const query = {};
      if (email) {
        query.email = email;
        const user = await usersCollection.findOne(query);
        return res.send(user);
      }

      const users = await usersCollection.find(query).toArray();
      res.send(users);
    });

    app.post("/users", verifyFBToken, async (req, res) => {
      const user = { ...req.body, createdAt: new Date() };

      const email = user.email;
      if (email !== req.decoded_email) {
        return res.status(403).send({ message: "Forbidden Access" });
      }
      const query = { email };

      const existingUser = await usersCollection.findOne(query);
      if (existingUser) {
        return res.send({ message: "User Exists" });
      }

      const result = await usersCollection.insertOne(user);
      res.send(result);
    });
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});
