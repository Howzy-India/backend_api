package com.example.controller;

import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.security.Principal;
import java.util.HashMap;
import java.util.Map;

@RestController
@RequestMapping("/api/v1/dashboard")
public class DashboardController {

    @GetMapping("/public")
    public Map<String, String> getPublicDashboard() {
        Map<String, String> response = new HashMap<>();
        response.put("message", "Welcome to public info. No authentication required.");
        return response;
    }

    @GetMapping("/user")
    @PreAuthorize("isAuthenticated()")
    public Map<String, Object> getUserDashboard(Principal principal) {
        Map<String, Object> response = new HashMap<>();
        response.put("message", "Welcome " + principal.getName() + " to the User Dashboard.");
        response.put("user", principal.getName());
        return response;
    }

    @GetMapping("/agent")
    @PreAuthorize("hasRole('Agent') or hasRole('Admin') or hasRole('SuperAdmin')")
    public Map<String, String> getAgentDashboard() {
        Map<String, String> response = new HashMap<>();
        response.put("message", "Welcome to the Agent Dashboard.");
        response.put("data", "Tickets, Customers");
        return response;
    }

    @GetMapping("/admin")
    @PreAuthorize("hasRole('Admin') or hasRole('SuperAdmin')")
    public Map<String, String> getAdminDashboard() {
        Map<String, String> response = new HashMap<>();
        response.put("message", "Welcome to the Admin Dashboard.");
        response.put("data", "Manage Agents, System Reports");
        return response;
    }

    @GetMapping("/superadmin")
    @PreAuthorize("hasRole('SuperAdmin')")
    public Map<String, String> getSuperAdminDashboard() {
        Map<String, String> response = new HashMap<>();
        response.put("message", "Welcome to the SuperAdmin Dashboard.");
        response.put("data", "Manage Admins, Master System Settings, Audit Logs");
        return response;
    }
}
