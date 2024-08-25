import React, { useEffect, useRef, useState, useCallback } from "react";
import { SafeAreaView } from "react-native";
import {
  Button,
  findNodeHandle,
  NativeModules,
  View,
  Platform,
  Text,
  Alert,
} from "react-native";
import { useIsCaptured } from "react-native-is-screen-captured-ios";
import {
  mediaDevices,
  MediaStream,
  RTCView,
  ScreenCapturePickerView,
  RTCPeerConnection,
  RTCIceCandidate,
  RTCSessionDescription,
} from "react-native-webrtc";
import io from "socket.io-client";

interface Props {}

const Demo: React.FC<Props> = () => {
  const screenCapturePickerViewRef = useRef(null);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [connectionStatus, setConnectionStatus] =
    useState<string>("Not connected");
  const [remotePeerId, setRemotePeerId] = useState<string | null>(null);
  const isCaptured = useIsCaptured();

  const socketRef = useRef<any>(null);
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);

  const initializeSocket = useCallback(() => {
    if (socketRef.current) {
      console.log("Socket already initialized");
      return socketRef.current;
    }

    const newSocket = io(
      "https://756c-2600-1010-b064-3aeb-18e2-f3aa-fe99-6018.ngrok-free.app",
      {
        transports: ["websocket"],
        reconnection: true,
        reconnectionAttempts: 5,
        reconnectionDelay: 1000,
      }
    );

    newSocket.on("connect", () => {
      console.log("Connected to WebSocket server");
      setConnectionStatus("Connected to signaling server");
    });

    newSocket.on("connect_error", (error) => {
      console.error("WebSocket connection error:", error);
      setConnectionStatus("Signaling server connection error");
    });

    newSocket.on("offer", (data) => handleIncomingOffer(data));
    newSocket.on("answer", (data) => handleIncomingAnswer(data));
    newSocket.on("ice-candidate", (data) => handleIncomingICECandidate(data));

    socketRef.current = newSocket;

    return newSocket;
  }, []);

  useEffect(() => {
    const newSocket = initializeSocket();

    return () => {
      if (newSocket) {
        newSocket.disconnect();
      }
      socketRef.current = null;
    };
  }, [initializeSocket]);

  const initializePeerConnection = useCallback(() => {
    if (peerConnectionRef.current) {
      console.log("Closing existing PeerConnection");
      peerConnectionRef.current.close();
    }

    console.log("Initializing new PeerConnection");
    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" },
        { urls: "stun:stun2.l.google.com:19302" },
      ],
    });

    pc.addEventListener("icecandidate", (event) => {
      if (event.candidate && socketRef.current && remotePeerId) {
        console.log("Sending ICE candidate");
        socketRef.current.emit("ice-candidate", {
          to: remotePeerId,
          candidate: event.candidate.toJSON(),
        });
      }
    });

    pc.addEventListener("connectionstatechange", () => {
      console.log("Peer Connection State:", pc.connectionState);
      setConnectionStatus("Peer Connection: " + pc.connectionState);
    });

    pc.addEventListener("signalingstatechange", () => {
      console.log("Signaling State:", pc.signalingState);
    });

    pc.addEventListener("track", handleTrack);

    // Create data channel
    const dc = pc.createDataChannel("myDataChannel");
    dc.onopen = () => {
      console.log("Data channel open");
      dataChannelRef.current = dc;
    };
    dc.onmessage = (event) => console.log("Received message:", event.data);

    // Handle incoming data channels
    pc.ondatachannel = (event) => {
      const incomingDc = event.channel;
      incomingDc.onopen = () => {
        console.log("Incoming data channel open");
        dataChannelRef.current = incomingDc;
      };
      incomingDc.onmessage = (evt) =>
        console.log("Received message on incoming channel:", evt.data);
    };

    peerConnectionRef.current = pc;
    return pc;
  }, [remotePeerId]);

  const startSimulatorSession = async () => {
    try {
      const _stream = await mediaDevices.getUserMedia({
        video: {
          facingMode: "user",
          width: 640,
          height: 480,
          frameRate: 30,
        },
        audio: true,
      });
      console.log("Camera stream:", _stream);
      setLocalStream(_stream);
      const pc = initializePeerConnection();
      _stream.getTracks().forEach((track) => {
        console.log("Adding track to peer connection:", track.kind);
        pc.addTrack(track, _stream);
      });
    } catch (error) {
      console.error("Error starting simulator session:", error);
      Alert.alert(
        "Error",
        "Failed to start camera stream. Please check permissions."
      );
    }
  };

  const createOffer = async () => {
    if (!peerConnectionRef.current || !socketRef.current) {
      console.error("PeerConnection or Socket not initialized");
      return;
    }

    try {
      const offer = await peerConnectionRef.current.createOffer();
      await peerConnectionRef.current.setLocalDescription(offer);
      console.log("Offer created:", offer);
      socketRef.current.emit("offer", { type: offer.type, sdp: offer.sdp });
      console.log("Offer sent to server");
    } catch (error) {
      console.error("Error creating offer:", error);
      Alert.alert("Error", "Failed to create offer. Please try again.");
    }
  };

  const handleIncomingOffer = async (data) => {
    try {
      console.log("Received offer:", data);
      const pc = initializePeerConnection();
      if (!data || !data.offer || !data.offer.type || !data.offer.sdp) {
        throw new Error("Invalid offer received");
      }
      setRemotePeerId(data.from);
      await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      if (socketRef.current) {
        socketRef.current.emit("answer", {
          to: data.from,
          type: answer.type,
          sdp: answer.sdp,
        });
        console.log("Answer sent to server");
      } else {
        console.error("Socket not initialized, cannot send answer");
      }
    } catch (error) {
      console.error("Error handling incoming offer:", error);
      Alert.alert(
        "Error",
        "Failed to process incoming offer. Please try reconnecting."
      );
    }
  };

  const handleIncomingAnswer = async (data) => {
    try {
      console.log("Received answer:", data);
      if (peerConnectionRef.current && data && data.type && data.sdp) {
        setRemotePeerId(data.from);
        await peerConnectionRef.current.setRemoteDescription(
          new RTCSessionDescription(data)
        );
        console.log("Remote description set successfully");
      } else {
        console.error("Invalid answer or peerConnection not initialized");
        console.log("peerConnection:", peerConnectionRef.current);
        console.log("answer data:", data);
      }
    } catch (error) {
      console.error("Error handling incoming answer:", error);
      Alert.alert(
        "Error",
        "Failed to process incoming answer. Please try reconnecting."
      );
    }
  };

  const handleIncomingICECandidate = async (data) => {
    try {
      if (peerConnectionRef.current && data && data.candidate) {
        await peerConnectionRef.current.addIceCandidate(
          new RTCIceCandidate(data.candidate)
        );
        console.log("ICE candidate added successfully");
      } else {
        console.error(
          "Invalid ICE candidate or peerConnection not initialized"
        );
      }
    } catch (error) {
      console.error("Error handling incoming ICE candidate:", error);
    }
  };

  const handleTrack = (event: RTCTrackEvent) => {
    console.log("Received remote track", event.track.kind);
    if (event.streams && event.streams[0]) {
      console.log("Setting remote stream");
      setRemoteStream(event.streams[0]);
    }
  };

  const sendMessage = () => {
    if (
      dataChannelRef.current &&
      dataChannelRef.current.readyState === "open"
    ) {
      const message =
        "Hello from " + (Platform.OS === "ios" ? "iOS" : "Android");
      dataChannelRef.current.send(message);
      console.log("Sent message:", message);
    } else {
      console.log("Data channel not open");
      Alert.alert(
        "Info",
        "Data channel is not open yet. Please wait for the connection to establish."
      );
    }
  };

  return (
    <SafeAreaView
      style={{
        flex: 1,
        backgroundColor: "#e6f2ff",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Text style={{ marginBottom: 10 }}>{connectionStatus}</Text>
      <View
        style={{ flex: 1, flexDirection: "row", padding: 10, width: "100%" }}
      >
        <View style={{ flex: 1, marginRight: 5 }}>
          <Text>Local Stream</Text>
          {localStream && (
            <RTCView
              style={{ flex: 1, backgroundColor: "#d4edda" }}
              objectFit="cover"
              streamURL={localStream.toURL()}
            />
          )}
        </View>
        <View style={{ flex: 1, marginLeft: 5 }}>
          <Text>Remote Stream</Text>
          {remoteStream && (
            <RTCView
              style={{ flex: 1, backgroundColor: "#d4edda" }}
              objectFit="cover"
              streamURL={remoteStream.toURL()}
            />
          )}
        </View>
      </View>
      {Platform.OS === "ios" && (
        <ScreenCapturePickerView ref={screenCapturePickerViewRef} />
      )}
      <View style={{ marginVertical: 20 }}>
        <Button onPress={startSimulatorSession} title="Start Session" />
        {localStream && <Button onPress={createOffer} title="Create Offer" />}
        <Button onPress={sendMessage} title="Send Test Message" />
        <Button
          onPress={() =>
            console.log("Socket connected:", socketRef.current?.connected)
          }
          title="Check Socket Connection"
        />
      </View>
    </SafeAreaView>
  );
};

export default Demo;
