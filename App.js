import React, { useEffect, useRef, useState } from "react";
import { View, Text, TouchableOpacity, TextInput, Switch } from "react-native";
import { Camera } from "expo-camera";
import * as tf from "@tensorflow/tfjs";
import "@tensorflow/tfjs-react-native";
import * as posedetection from "@tensorflow-models/pose-detection";
import { cameraWithTensors } from "@tensorflow/tfjs-react-native";
import * as Speech from "expo-speech";
import AsyncStorage from "@react-native-async-storage/async-storage";

import { initializeApp } from "firebase/app";
import { getFirestore, addDoc, collection } from "firebase/firestore";

/* ---------------- FIREBASE ---------------- */
const firebaseConfig = {
  apiKey: "YOUR_KEY",
  authDomain: "YOUR_DOMAIN",
  projectId: "YOUR_ID"
};
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

/* ---------------- AI (OPTIONAL) ---------------- */
const OPENAI_KEY = ""; // optional: paste your OpenAI key here

/* ---------------- TF CAMERA ---------------- */
const TensorCamera = cameraWithTensors(Camera);
let detector;
let stage = "up";
let repsGlobal = 0;

/* ---------------- UTILS ---------------- */
const angle = (a, b, c) => {
  const ab = { x: a.x - b.x, y: a.y - b.y };
  const cb = { x: c.x - b.x, y: c.y - b.y };
  const dot = ab.x * cb.x + ab.y * cb.y;
  const magA = Math.sqrt(ab.x ** 2 + ab.y ** 2);
  const magC = Math.sqrt(cb.x ** 2 + cb.y ** 2);
  return Math.acos(dot / (magA * magC)) * (180 / Math.PI);
};

/* ---------------- REP DETECTION ---------------- */
const detectPushup = (k) => {
  const ang = angle(k[6], k[8], k[10]);
  if (ang < 90 && stage === "up") stage = "down";
  if (ang > 160 && stage === "down") {
    stage = "up";
    repsGlobal++;
  }
  return repsGlobal;
};
const detectPullup = (k) => {
  if (k[0].y < k[10].y && stage === "down") stage = "up";
  if (k[0].y > k[10].y && stage === "up") {
    stage = "down";
    repsGlobal++;
  }
  return repsGlobal;
};
const detectBench = (k) => {
  const ang = angle(k[6], k[8], k[10]);
  if (ang < 70 && stage === "up") stage = "down";
  if (ang > 150 && stage === "down") {
    stage = "up";
    repsGlobal++;
  }
  return repsGlobal;
};

/* ---------------- FORM ANALYSIS ---------------- */
const analyze = (k) => {
  const ang = angle(k[6], k[8], k[10]);
  const issues = [];
  if (ang > 160) issues.push("Go lower");
  if (ang < 60) issues.push("Too deep");
  if (Math.abs(k[6].y - k[12].y) > 40) issues.push("Keep your body straight");
  return issues;
};

/* ---------------- AI COACH ---------------- */
const aiCoach = async (exercise, reps, issues) => {
  if (!OPENAI_KEY) return null;
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "user",
            content: `Exercise: ${exercise}, reps: ${reps}, issues: ${issues.join(", ")}. Give short coaching advice.`
          }
        ]
      })
    });
    const json = await res.json();
    return json.choices?.[0]?.message?.content || null;
  } catch {
    return null;
  }
};

/* ---------------- TRIAL ---------------- */
const checkTrial = async () => {
  const key = "trial_start";
  let start = await AsyncStorage.getItem(key);
  if (!start) {
    await AsyncStorage.setItem(key, Date.now().toString());
    return true;
  }
  const days = (Date.now() - parseInt(start)) / 86400000;
  return days <= 7;
};

/* ---------------- APP ---------------- */
export default function App() {
  const [hasPermission, setHasPermission] = useState(null);
  const [exercise, setExercise] = useState("Pushups");
  const [reps, setReps] = useState(0);
  const [aiEnabled, setAiEnabled] = useState(false);
  const [screen, setScreen] = useState("home");
  const [feedbackText, setFeedbackText] = useState("");
  const raf = useRef(null);
  let lastRun = 0;

  useEffect(() => {
    (async () => {
      const cam = await Camera.requestCameraPermissionsAsync();
      setHasPermission(cam.status === "granted");
      const trial = await checkTrial();
      if (!trial) alert("Trial expired");
      await tf.ready();
      detector = await posedetection.createDetector(
        posedetection.SupportedModels.MoveNet,
        { modelType: posedetection.movenet.modelType.SINGLEPOSE_LIGHTNING }
      );
    })();
  }, []);

  const onStream = (images) => {
    const loop = async () => {
      const now = Date.now();
      if (now - lastRun < 150) {
        raf.current = requestAnimationFrame(loop);
        return;
      }
      lastRun = now;
      const img = images.next().value;
      if (img && detector) {
        const poses = await detector.estimatePoses(img);
        const pose = poses[0];
        if (pose) {
          const k = pose.keypoints;
          let r = 0;
          if (exercise === "Pushups") r = detectPushup(k);
          if (exercise === "Pullups") r = detectPullup(k);
          if (exercise === "Bench") r = detectBench(k);
          setReps(r);
          const issues = analyze(k);
          if (issues.length > 0) Speech.speak(issues[0]);
          if (r > 0 && r % 5 === 0) {
            Speech.speak(`${r} reps`);
            if (aiEnabled) {
              const fb = await aiCoach(exercise, r, issues);
              if (fb) Speech.speak(fb);
            }
            try {
              await addDoc(collection(db, "workouts"), {
                exercise,
                reps: r,
                time: Date.now()
              });
            } catch {}
          }
        }
      }
      raf.current = requestAnimationFrame(loop);
    };
    loop();
  };

  if (hasPermission === null) return <Text>Loading...</Text>;
  if (!hasPermission) return <Text>No camera access</Text>;

  if (screen === "home") {
    return (
      <View style={{ flex: 1, backgroundColor: "#000", justifyContent: "center", alignItems: "center" }}>
        <Text style={{ color: "#fff", fontSize: 28 }}>AI Fitness Coach</Text>
        <TouchableOpacity onPress={() => setScreen("workout")}>
          <Text style={{ color: "cyan", margin: 10 }}>Start Workout</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => setScreen("feedback")}>
          <Text style={{ color: "cyan", margin: 10 }}>Feedback</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (screen === "workout") {
    return (
      <View style={{ flex: 1 }}>
        <TensorCamera
          style={{ flex: 1 }}
          type={Camera.Constants.Type.front}
          onReady={onStream}
          autorender
        />
        <View style={{ position: "absolute", top: 50, left: 20 }}>
          <Text style={{ color: "#fff", fontSize: 30 }}>{reps} reps</Text>
          {["Pushups", "Pullups", "Bench"].map((e) => (
            <TouchableOpacity key={e} onPress={() => setExercise(e)}>
              <Text style={{ color: "#fff" }}>{e}</Text>
            </TouchableOpacity>
          ))}
          <View style={{ flexDirection: "row", alignItems: "center" }}>
            <Text style={{ color: "#fff" }}>AI</Text>
            <Switch value={aiEnabled} onValueChange={setAiEnabled} />
          </View>
          <TouchableOpacity onPress={() => setScreen("home")}>
            <Text style={{ color: "red" }}>Back</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  if (screen === "feedback") {
    return (
      <View style={{ flex: 1, backgroundColor: "#000", padding: 20 }}>
        <TextInput
          placeholder="Your feedback"
          placeholderTextColor="#888"
          value={feedbackText}
          onChangeText={setFeedbackText}
          style={{ color: "#fff", borderBottomWidth: 1, marginBottom: 20 }}
        />
        <TouchableOpacity
          onPress={async () => {
            try {
              await addDoc(collection(db, "feedback"), { text: feedbackText, time: Date.now() });
              setFeedbackText("");
              alert("Submitted!");
            } catch {
              alert("Error submitting feedback");
            }
          }}
        >
          <Text style={{ color: "cyan" }}>Submit</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => setScreen("home")}>
          <Text style={{ color: "red", marginTop: 20 }}>Back</Text>
        </TouchableOpacity>
      </View>
    );
  }
}