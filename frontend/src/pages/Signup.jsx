import React from "react";
import Navbar from "../components/Navbar";
import AuthForm from "../components/AuthForm";
import { useNavigate } from "react-router-dom";
import { useState } from "react";
import toast from "react-hot-toast";

export default function Signup() {
  const API_URL = import.meta.env.VITE_API_URL;
  const navigate = useNavigate();
  const [isLoading, setIsloading] = useState(false);

  const handleSignup = async (formData, setFormData) => {
    setIsloading(true);
    try {
      const res = await fetch(`${API_URL}/api/auth/signup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(formData),
      });
      const data = await res.json();

      if (!res.ok) throw new Error(data.message || "Sign up failed");

      setFormData({
        name: "",
        email: "",
        password: "",
      });
      toast.success("Signup successful");
      navigate("/login");
    } catch (err) {
      console.error(err);
      toast.error(err.message);
    } finally {
      setIsloading(false);
    }
  };
  return (
    <div className="min-h-screen bg-[#1f2028]">
      <Navbar />

      <div className="my-40">
        <AuthForm type="signup" onSubmit={handleSignup} isLoading={isLoading} />
      </div>
    </div>
  );
}
