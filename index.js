const express = require("express");
const cors = require("cors");
const app = express();
const port = process.env.PORT || 5000;
require("dotenv").config();
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const stripe = require("stripe")(process.env.STRIPE_SECRET);

// middlewares
app.use(cors());
app.use(express.json());

const admin = require("firebase-admin");
const serviceAccount = require("./digital-life-lesson-firebase-adminsdk.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

// custom middlewares
const verifyFBToken = async (req, res, next) => {
  const token = req.headers.authorization;

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
    const favoritesCollection = db.collection("favorite-lessons");
    const reportsCollection = db.collection("reports");
    const commentsCollection = db.collection("comments");

    // middleware to access db
    const verifyAdmin = async (req, res, next) => {
      const email = req.decoded_email;
      const user = await usersCollection.findOne({ email });
      if (!user || user.role !== "admin") {
        return res.status(403).send({ message: "Forbidden Access" });
      }
      next();
    };
    // admin dashboard apis
    app.get("/admin-overview", verifyFBToken, verifyAdmin, async (req, res) => {
      const totalUsers = await usersCollection.countDocuments();

      const totalPublicLessons = await lessonsCollection.countDocuments({
        privacy: "Public",
      });

      const totalReportedLessons = await lessonsCollection.countDocuments({
        isReported: true,
      });

      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const todayNewLessons = await lessonsCollection.countDocuments({
        createdAt: { $gte: today },
      });

      const mostActiveContributors = await lessonsCollection
        .aggregate([
          {
            $group: {
              _id: "$authorEmail",
              name: { $first: "$authorName" },
              photo: { $first: "$authorPhoto" },
              lessonCount: { $sum: 1 },
              authorId: { $first: "$authorId" },
            },
          },
          { $sort: { lessonCount: -1 } },
          { $limit: 5 },
        ])
        .toArray();

      res.send({
        totalUsers,
        totalPublicLessons,
        totalReportedLessons,
        todayNewLessons,
        mostActiveContributors,
      });
    });

    app.get("/admin/users", verifyFBToken, verifyAdmin, async (req, res) => {
      const usersWithLessonCount = await usersCollection
        .aggregate([
          {
            $lookup: {
              from: "lessons",
              localField: "email",
              foreignField: "authorEmail",
              as: "userLessons",
            },
          },
          {
            $project: {
              displayName: 1,
              email: 1,
              role: 1,
              photoURL: 1,
              totalLessons: { $size: "$userLessons" },
            },
          },
        ])
        .toArray();

      res.send(usersWithLessonCount);
    });

    //user profile api:
    app.get("/user-profile-info", async (req, res) => {
      const { email } = req.query;
      const totalCreated = await lessonsCollection.countDocuments({
        authorEmail: email,
      });

      const totalSaved = await lessonsCollection.countDocuments({
        favorites: email,
      });

      const myPublicLessons = await lessonsCollection
        .find({ authorEmail: email, privacy: "Public" })
        .sort({ createdAt: -1 })
        .toArray();

      res.send({
        totalCreated,
        totalSaved,
        myPublicLessons,
      });
    });

    // homepage api
    app.get("/home-dynamic-data", async (req, res) => {
      const featuredLessons = await lessonsCollection
        .find({ privacy: "Public", isFeatured: true })
        .limit(3)
        .toArray();

      const mostSavedLessons = await lessonsCollection
        .aggregate([
          { $match: { privacy: "Public" } },
          { $addFields: { favCount: { $size: "$favorites" } } },
          { $sort: { favCount: -1 } },
          { $limit: 3 },
        ])
        .toArray();

      const topContributors = await lessonsCollection
        .aggregate([
          { $match: { privacy: "Public" } },
          {
            $group: {
              _id: "$authorEmail",
              lessonCount: { $sum: 1 },
              authorName: { $first: "$authorName" },
              authorPhoto: { $first: "$authorPhoto" },
              authorId: { $first: "$authorId" },
            },
          },
          { $sort: { lessonCount: -1 } },
          { $limit: 4 },
        ])
        .toArray();

      res.send({
        featuredLessons,
        mostSavedLessons,
        topContributors,
      });
    });
    // comments related apis

    app.get("/comments/:lessonId", async (req, res) => {
      const id = req.params.lessonId;
      const query = { lessonId: id };
      const result = await commentsCollection
        .find(query)
        .sort({ _id: -1 })
        .toArray();
      res.send(result);
    });

    app.post("/comments", async (req, res) => {
      const commentData = req.body;
      const result = await commentsCollection.insertOne(commentData);
      res.send(result);
    });

    // payment related apis:
    app.post("/payment-checkout-session", verifyFBToken, async (req, res) => {
      const { price, userEmail } = req.body;
      const session = await stripe.checkout.sessions.create({
        line_items: [
          {
            price_data: {
              currency: "usd",
              product_data: {
                name: "Digital Life Lesson Premium",
              },
              unit_amount: price * 100,
            },
            quantity: 1,
          },
        ],
        metadata: {
          email: userEmail,
        },
        mode: "payment",
        customer_email: userEmail,
        success_url: `${process.env.SITE_DOMAIN}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.SITE_DOMAIN}/payment-cancel`,
      });

      res.send({ url: session.url });
    });

    // lesson related apis
    app.get("/lessons", verifyFBToken, async (req, res) => {
      const { email } = req.query;
      const query = {};
      if (email) {
        if (email !== req.decoded_email) {
          return res.status(403).send({ message: "Forbidden Access" });
        }
        query.authorEmail = email;
        const result = await lessonsCollection.find(query).toArray();
        return res.send(result);
      }
      const result = await lessonsCollection.find(query).toArray();
      res.send(result);
    });

    app.get("/public-lessons", async (req, res) => {
      const { search, category, tone, sort, page = 1, limit = 12 } = req.query;
      const skip = (parseInt(page) - 1) * parseInt(limit);

      const query = { privacy: "Public" };
      if (search) query.title = { $regex: search, $options: "i" };
      if (category) query.category = category;
      if (tone) query.tone = tone;

      let lessons;
      if (sort === "most-saved") {
        lessons = await lessonsCollection
          .aggregate([
            { $match: query },
            {
              $addFields: {
                favCount: { $size: "$favorites" },
              },
            },
            { $sort: { favCount: -1 } },
            { $skip: skip },
            { $limit: parseInt(limit) },
          ])
          .toArray();
      } else {
        const sortObj = { createdAt: -1 };
        lessons = await lessonsCollection
          .find(query)
          .sort(sortObj)
          .skip(skip)
          .limit(parseInt(limit))
          .toArray();
      }

      const total = await lessonsCollection.countDocuments(query);

      res.send({ lessons, total });
    });

    app.get("/dashboard-stats", verifyFBToken, async (req, res) => {
      const { email } = req.query;

      if (email !== req.decoded_email) {
        return res.status(403).send({ message: "forbidden" });
      }

      const totalCreated = await lessonsCollection.countDocuments({
        authorEmail: email,
      });

      const totalSaved = await lessonsCollection.countDocuments({
        favorites: email,
      });

      const recentLessons = await lessonsCollection
        .find({ authorEmail: email })
        .sort({ createdAt: -1 })
        .limit(3)
        .toArray();

      const chartData = await lessonsCollection
        .aggregate([
          { $match: { authorEmail: email } },
          { $group: { _id: "$category", count: { $sum: 1 } } },
        ])
        .toArray();

      res.send({
        totalCreated,
        totalSaved,
        recentLessons,
        chartData,
      });
    });

    app.get("/lessons/similar", async (req, res) => {
      const { category, tone, id } = req.query;
      const query = {
        _id: { $ne: new ObjectId(id) },
        $or: [{ category }, { tone }],
      };
      const result = await lessonsCollection.find(query).limit(6).toArray();
      res.send(result);
    });

    app.get("/my-favorites", verifyFBToken, async (req, res) => {
      const { email, category, tone } = req.query;
      if (email !== req.decoded_email) {
        return res.status(403).send({ message: "forbidden" });
      }
      const query = { favorites: email };
      if (category) query.category = category;
      if (tone) query.tone = tone;

      const favorites = await lessonsCollection.find(query).toArray();
      res.send(favorites);
    });

    app.get("/lessons/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const lesson = await lessonsCollection.findOne(query);
      if (!lesson) {
        return res.send({ message: "Lesson not found" });
      }
      const totalLessons = await lessonsCollection.countDocuments({
        authorEmail: lesson.authorEmail,
      });
      lesson.totalLessons = totalLessons;
      res.send(lesson);
    });

    app.get("/lessons/author/:authorId", async (req, res) => {
      const { authorId } = req.params;
      const query = { authorId };
      const result = await lessonsCollection.find(query).toArray();

      res.send(result);
    });

    app.post("/lessons", verifyFBToken, async (req, res) => {
      const lesson = { ...req.body, createdAt: new Date() };
      const { authorEmail } = lesson;
      if (authorEmail !== req.decoded_email) {
        return res.status(403).send({ message: "Forbidden Access" });
      }
      const result = await lessonsCollection.insertOne(lesson);
      res.send(result);
    });

    app.delete("/lessons/:id", verifyFBToken, async (req, res) => {
      const { id } = req.params;
      const { query } = { _id: new ObjectId(id) };
      const lesson = await lessonsCollection.findOne(query);
      if (!lesson) {
        return res.status(404).send({ message: "Lesson not found" });
      }
      if (lesson.authorEmail !== req.decoded_email) {
        return res
          .status(403)
          .send({ message: "You cannot delete someone else's lesson!" });
      }

      const result = await lessonsCollection.deleteOne(query);
      res.send(result);
    });

    app.patch("/lessons/:id", verifyFBToken, async (req, res) => {
      const { id } = req.params;
      const updatedLesson = req.body;
      console.log(updatedLesson);
      const query = { _id: new ObjectId(id) };
      const existingLesson = await lessonsCollection.findOne(query);
      if (!existingLesson) {
        return res.status(404).send({ message: "Lesson not found!" });
      }
      if (existingLesson.authorEmail !== req.decoded_email) {
        return res
          .status(403)
          .send({ message: "You cannot update someone else's lesson!" });
      }
      const { _id, createdAt, ...updatedData } = updatedLesson;
      const updatedDoc = {
        $set: { ...updatedData, updatedAt: new Date() },
      };
      const result = await lessonsCollection.updateOne(query, updatedDoc);
      res.send(result);
    });

    app.patch("/lessons/like/:id", verifyFBToken, async (req, res) => {
      const id = req.params.id;
      const email = req.body.email;
      if (email !== req.decoded_email) {
        return res.status(403).send({ message: "forbidden" });
      }
      const lesson = await lessonsCollection.findOne({ _id: new ObjectId(id) });
      if (!lesson) {
        return res.send({ message: "No Lesson" });
      }

      let updateDoc;
      if (lesson.likes?.includes(email)) {
        updateDoc = { $pull: { likes: email } };
      } else {
        updateDoc = { $addToSet: { likes: email } };
      }
      const result = await lessonsCollection.updateOne(
        { _id: new ObjectId(id) },
        updateDoc,
      );
      res.send(result);
    });

    app.patch("/lessons/favorites/:id", verifyFBToken, async (req, res) => {
      const { id } = req.params;
      const { email } = req.body;
      if (email !== req.decoded_email) {
        return res.status(403).send({ message: "forbidden" });
      }
      const lesson = await lessonsCollection.findOne({ _id: new ObjectId(id) });
      if (!lesson) {
        return res.send({ message: "No Lesson" });
      }
      let updateDoc;
      if (lesson.favorites?.includes(email)) {
        updateDoc = { $pull: { favorites: email } };
      } else {
        updateDoc = { $addToSet: { favorites: email } };
      }
      const result = await lessonsCollection.updateOne(
        { _id: new ObjectId(id) },
        updateDoc,
      );
      res.send(result);
    });

    app.put("/my-favorites/remove", async (req, res) => {
      const { lessonId, email } = req.body;
      const result = await lessonsCollection.updateOne(
        { _id: new ObjectId(lessonId) },
        { $pull: { favorites: email } },
      );
      res.send(result);
    });

    // lesson report related apis
    app.post("/lesson-report", verifyFBToken, async (req, res) => {
      const reportData = req.body;
      const { lessonId, reporterUserId } = reportData;
      const alreadyReported = await reportsCollection.findOne({
        lessonId,
        reporterUserId,
      });

      if (alreadyReported) {
        return res.send({ message: "Already Reported" });
      }

      const result = await reportsCollection.insertOne(reportData);

      await lessonsCollection.updateOne(
        { _id: new ObjectId(lessonId) },
        { $set: { isReported: true } },
      );

      res.send(result);
    });

    // user related apis:
    app.get("/users", verifyFBToken, async (req, res) => {
      const { email } = req.query;
      const query = {};
      if (email) {
        if (email !== req.decoded_email) {
          return res.status(403).send({ message: "Forbidden Access" });
        }
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

    app.patch("/users/upgrade/:email", verifyFBToken, async (req, res) => {
      const email = req.params.email;

      if (email !== req.decoded_email) {
        return res.status(403).send({ message: "Forbidden Access" });
      }

      const filter = { email: email };
      const updatedDoc = {
        $set: {
          isPremiumUser: true,
        },
      };

      const result = await usersCollection.updateOne(filter, updatedDoc);
      res.send(result);
    });

    app.patch("/users/update-profile", verifyFBToken, async (req, res) => {
      const { email } = req.query;
      const { name, photo } = req.body;

      if (email !== req.decoded_email) {
        return res.status(403).send({ message: "Forbidden Access" });
      }

      const query = { email };
      const updateDoc = {
        $set: {
          displayName: name,
          photoURL: photo,
        },
      };

      const userResult = await usersCollection.updateOne(query, updateDoc);

      const response = await lessonsCollection.updateMany(
        { authorEmail: email },
        {
          $set: {
            authorName: name,
            authorPhoto: photo,
          },
        },
      );

      res.send(userResult);
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
